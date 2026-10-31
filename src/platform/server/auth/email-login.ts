import type { Cookies } from '@sveltejs/kit';
import { exec, one, query, transaction } from '../db';
import { config } from '../config';
import { hashPassword, verifyPassword } from '../util/crypto';
import { newId } from '../util/ids';
import { sendEmail } from '../util/smtp';
import { getTenant } from '../tenant/tenant';
import { withTenant, type Tenant } from '../tenant/context';
import { createSession } from './session';
import { rolesFor } from './users';
import type { Role } from '../authz/roles';

/**
 * Signing in with a code sent to an address.
 *
 * A third way into the record, next to HelseID and username-and-password, and
 * the weakest of the three: it proves someone reads mail at an address, which
 * is not the same as proving who they are. That is enough for a person trying
 * the system out with synthetic data, and not enough for a clinician opening a
 * real record - which is why HelseID exists and why this is governed by its
 * own switch, off by default in anything that sees real patients.
 *
 * The mechanics are the developer portal's: six digits, fifteen minutes, one
 * use, five attempts, and the same answer whether or not the address is known.
 */

const CODE_TTL_SECONDS = 900;
const MAX_ATTEMPTS = 5;

export interface AccountMatch {
	userId: string;
	tenantId: string;
	tenantName: string;
	name: string;
}

/**
 * Every account with this address, across organisations.
 *
 * Deliberately not bounded to one organisation: on the shared trial hostname
 * there is no hostname to derive one from, and the same person may have an
 * account at more than one practice. Nothing is disclosed by this - the caller
 * only ever learns of accounts after a code sent to that very address has been
 * entered correctly.
 */
export async function accountsForEmail(email: string): Promise<AccountMatch[]> {
	return query<AccountMatch>(
		`SELECT u.id AS "userId", u.tenant_id AS "tenantId", t.name AS "tenantName", u.name
		 FROM user_account u JOIN tenant t ON t.id = u.tenant_id
		 WHERE lower(u.email) = lower($1) AND u.status = 'aktiv' AND t.status = 'aktiv'
		 ORDER BY t.name`,
		[email]
	);
}

/** Sends a code, whether or not the address belongs to anyone. */
export async function requestEmailCode(email: string, tenantId: string | null, ip: string | null): Promise<void> {
	const address = email.trim().toLowerCase();

	const recent = await one<{ n: number }>(
		"SELECT count(*)::int AS n FROM user_login_code WHERE email = $1 AND created_at > now() - interval '15 minutes'",
		[address]
	);
	if ((recent?.n ?? 0) >= 5) throw new Error('For mange forespørsler. Vent litt før du prøver igjen.');

	const code = String(Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000)).padStart(6, '0');
	await transaction(async () => {
		await exec('UPDATE user_login_code SET used_at = now() WHERE email = $1 AND used_at IS NULL', [address]);
		await exec(
			`INSERT INTO user_login_code (id, email, tenant_id, code_hash, expires_at, ip)
			 VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, $6)`,
			[newId(), address, tenantId, hashPassword(code), String(CODE_TTL_SECONDS), ip]
		);
	});

	if (config.testLogin.aktivert) console.log(`[epost-innlogging] kode for ${address}: ${code}`);

	await sendEmail({
		to: address,
		subject: `Påloggingskode ${code}`,
		text: [
			`Koden din er ${code}.`,
			'',
			`Gyldig i ${Math.round(CODE_TTL_SECONDS / 60)} minutter, og kan brukes én gang.`,
			'',
			'Har du ikke bedt om å logge inn, kan du se bort fra denne meldingen.',
			'',
			`${config.baseUrl.replace(/\/$/, '')}`
		].join('\n')
	});
}

/**
 * Checks the code. Says which accounts it unlocks, without signing anyone in.
 *
 * Separated from the signing-in below because a person may have an account at
 * more than one practice, and choosing between them is a question that can
 * only be asked once the code is known to be right.
 */
export async function verifyEmailCode(
	email: string,
	code: string
): Promise<{ ok: true; accounts: AccountMatch[] } | { ok: false; error: string }> {
	const address = email.trim().toLowerCase();
	const row = await one<{ id: string; code_hash: string; attempts: number }>(
		`SELECT id, code_hash, attempts FROM user_login_code
		 WHERE email = $1 AND used_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC LIMIT 1`,
		[address]
	);
	if (!row) return { ok: false, error: 'Koden er brukt opp eller utløpt. Be om en ny.' };
	if (row.attempts >= MAX_ATTEMPTS) {
		await exec('UPDATE user_login_code SET used_at = now() WHERE id = $1', [row.id]);
		return { ok: false, error: 'For mange forsøk på denne koden. Be om en ny.' };
	}
	if (!verifyPassword(code.trim(), row.code_hash)) {
		await exec('UPDATE user_login_code SET attempts = attempts + 1 WHERE id = $1', [row.id]);
		return { ok: false, error: 'Feil kode.' };
	}
	await exec('UPDATE user_login_code SET used_at = now() WHERE id = $1', [row.id]);

	const accounts = await accountsForEmail(address);
	if (!accounts.length) {
		// The code was right, but the address belongs to nobody. Said plainly:
		// there is nothing to protect here, and nothing to guess.
		return { ok: false, error: 'Ingen konto er knyttet til denne adressen.' };
	}
	return { ok: true, accounts };
}

/** Starts a session for one of the accounts a verified code unlocked. */
export async function signInAs(
	account: AccountMatch,
	cookies: Cookies,
	ip: string | null,
	userAgent: string | null
): Promise<{ tenant: Tenant; roles: Role[] }> {
	const tenant = await getTenant(account.tenantId);
	if (!tenant) throw new Error('Virksomheten finnes ikke lenger.');

	return withTenant(tenant, async () => {
		await createSession(account.userId, 'epost', ip ?? '', userAgent, cookies);
		await exec('UPDATE user_account SET last_login = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1', [
			account.userId
		]);
		return { tenant, roles: await rolesFor(account.userId) };
	});
}
