import type { Cookies } from '@sveltejs/kit';
import { exec, one, query, transaction } from '../db';
import { config } from '../config';
import { hashPassword, likeStrenger, tokenHash, verifyPassword } from '../util/crypto';
import { newId, newToken } from '../util/ids';
import { sendEmail } from '../util/smtp';

/**
 * Developer accounts for the app portal.
 *
 * Deliberately outside the record's own user model. A developer is not a
 * member of a practice, has no role and no patient access whatsoever - the
 * only thing they can reach is their own apps and what the platform has said
 * about them. Keeping the two apart means there is no path, however
 * misconfigured, from a developer account into a patient record.
 *
 * Sign-in is a code sent to the address, and nothing else. There is no
 * password to leak, reuse or reset, and what proves who someone is - that they
 * read mail at the address their apps are registered to - is the same thing
 * that matters when an app has to be revoked in a hurry.
 */

const CODE_TTL_SECONDS = 900;
const SESSION_TTL_SECONDS = 12 * 3600;
const MAX_ATTEMPTS = 5;
export const SESSION_COOKIE = 'epj_utvikler';

export interface Developer {
	id: string;
	email: string;
	name: string;
	organisation: string;
	status: string;
	created_at: string;
	last_login: string | null;
}

export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
	// Deliberately loose. The address either receives the code or it does not,
	// and that is a better test than any pattern.
	return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

/**
 * Sends a sign-in code.
 *
 * The same answer is given whether or not the address is known: a portal that
 * says which addresses have accounts is a list of who builds what, and the
 * account is created on first successful sign-in anyway.
 */
export async function requestLoginCode(email: string, ip: string | null): Promise<void> {
	const address = normaliseEmail(email);

	// One live code at a time per address, and a ceiling on how often one can be
	// asked for - otherwise this is a way to send mail to strangers.
	const recent = await one<{ n: number }>(
		"SELECT count(*)::int AS n FROM developer_login_code WHERE email = $1 AND created_at > now() - interval '15 minutes'",
		[address]
	);
	if ((recent?.n ?? 0) >= 5) throw new Error('For mange forespørsler. Vent litt før du prøver igjen.');

	// Six digits, from a source that is actually random.
	const code = String(Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000)).padStart(6, '0');

	await transaction(async () => {
		await exec('UPDATE developer_login_code SET used_at = now() WHERE email = $1 AND used_at IS NULL', [address]);
		await exec(
			`INSERT INTO developer_login_code (id, email, code_hash, expires_at, ip)
			 VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval, $5)`,
			[newId(), address, hashPassword(code), String(CODE_TTL_SECONDS), ip]
		);
	});

	await sendEmail({
		to: address,
		subject: `Påloggingskode ${code}`,
		text: [
			`Koden din er ${code}.`,
			'',
			`Den er gyldig i ${Math.round(CODE_TTL_SECONDS / 60)} minutter og kan brukes én gang.`,
			'',
			'Har du ikke bedt om å logge inn, kan du se bort fra denne meldingen.',
			'Da har noen skrevet inn adressen din - de kommer ingen vei uten koden.',
			'',
			`${config.baseUrl.replace(/\/$/, '')} · utviklerportalen`
		].join('\n')
	});
}

/** Checks the code and starts a session. The account is created if it is new. */
export async function completeLogin(
	email: string,
	code: string,
	cookies: Cookies,
	ip: string | null,
	userAgent: string | null
): Promise<{ ok: true; developer: Developer } | { ok: false; error: string }> {
	const address = normaliseEmail(email);
	const row = await one<{ id: string; code_hash: string; attempts: number }>(
		`SELECT id, code_hash, attempts FROM developer_login_code
		 WHERE email = $1 AND used_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC LIMIT 1`,
		[address]
	);
	if (!row) return { ok: false, error: 'Koden er brukt opp eller utløpt. Be om en ny.' };
	if (row.attempts >= MAX_ATTEMPTS) {
		await exec('UPDATE developer_login_code SET used_at = now() WHERE id = $1', [row.id]);
		return { ok: false, error: 'For mange forsøk på denne koden. Be om en ny.' };
	}

	if (!verifyPassword(code.trim(), row.code_hash)) {
		await exec('UPDATE developer_login_code SET attempts = attempts + 1 WHERE id = $1', [row.id]);
		return { ok: false, error: 'Feil kode.' };
	}
	await exec('UPDATE developer_login_code SET used_at = now() WHERE id = $1', [row.id]);

	const developer = await transaction(async () => {
		let found = await one<Developer>('SELECT * FROM developer WHERE email = $1', [address]);
		if (!found) {
			const id = newId();
			await exec('INSERT INTO developer (id, email) VALUES ($1,$2)', [id, address]);
			found = await one<Developer>('SELECT * FROM developer WHERE id = $1', [id]);
		}
		await exec('UPDATE developer SET last_login = now() WHERE id = $1', [(found as Developer).id]);
		return found as Developer;
	});

	if (developer.status !== 'aktiv') return { ok: false, error: 'Kontoen er sperret.' };

	const id = newId();
	const token = newToken(32);
	await exec(
		`INSERT INTO developer_session (id, developer_id, token_hash, expires_at, ip, user_agent)
		 VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval, $5,$6)`,
		[id, developer.id, tokenHash(token), String(SESSION_TTL_SECONDS), ip, userAgent]
	);
	cookies.set(SESSION_COOKIE, `${id}.${token}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: config.security.httpsOnly,
		maxAge: SESSION_TTL_SECONDS
	});
	return { ok: true, developer };
}

export async function developerFromSession(cookies: Cookies): Promise<Developer | null> {
	const raw = cookies.get(SESSION_COOKIE);
	if (!raw) return null;
	const [id, token] = raw.split('.');
	if (!id || !token) return null;

	const row = await one<{ developer_id: string; token_hash: string }>(
		'SELECT developer_id, token_hash FROM developer_session WHERE id = $1 AND expires_at > now()',
		[id]
	);
	// Compared in constant time, like every other token in the record.
	if (!row || !likeStrenger(row.token_hash, tokenHash(token))) return null;

	const developer = await one<Developer>("SELECT * FROM developer WHERE id = $1 AND status = 'aktiv'", [
		row.developer_id
	]);
	return developer ?? null;
}

export async function endDeveloperSession(cookies: Cookies): Promise<void> {
	const raw = cookies.get(SESSION_COOKIE);
	if (raw) await exec('DELETE FROM developer_session WHERE id = $1', [raw.split('.')[0]]);
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

export async function updateDeveloper(id: string, name: string, organisation: string): Promise<void> {
	await exec('UPDATE developer SET name = $2, organisation = $3 WHERE id = $1', [id, name, organisation]);
}

export async function listDevelopers(): Promise<Developer[]> {
	return query<Developer>('SELECT * FROM developer ORDER BY created_at DESC');
}
