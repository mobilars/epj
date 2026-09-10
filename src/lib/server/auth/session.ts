import type { Cookies } from '@sveltejs/kit';
import { one, exec } from '../db';
import { requireTenant } from '../tenant/context';
import { config } from '../config';
import { newId, newToken } from '../util/ids';
import { likeStrenger, tokenHash } from '../util/crypto';

export interface Session {
	id: string;
	user_id: string;
	created_at: string;
	last_active: string;
	expires_at: string;
	amr: string | null;
	elevated_until: string | null;
	ip: string | null;
}

/**
 * Innloggingssesjoner for journalens eget grensesnitt.
 *
 * Cookien er HttpOnly, SameSite=Strict og Secure utenfor lokal utvikling, og
 * inneholder kun et tilfeldig token - aldri brukerdata. Sesjonen har både en
 * inaktivitetsgrense og en absolutt levetid.
 */
export async function createSession(
	userId: string,
	amr: string,
	ip: string,
	userAgent: string | null,
	cookies: Cookies
): Promise<string> {
	const id = newId();
	const token = newToken(32);
	const expires_at = new Date(Date.now() + config.session.absoluteSeconds * 1000).toISOString();
	await exec(
		'INSERT INTO user_session (id, token_hash, user_id, expires_at, ip, user_agent, amr) VALUES ($1,$2,$3,$4,$5,$6,$7)',
		[id, tokenHash(token), userId, expires_at, ip, userAgent, amr]
	);
	cookies.set(config.session.cookieName, `${id}.${token}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: config.security.httpsOnly,
		maxAge: config.session.absoluteSeconds
	});
	return id;
}

export async function getSession(cookies: Cookies): Promise<Session | null> {
	const raw = cookies.get(config.session.cookieName);
	if (!raw) return null;
	const skille = raw.indexOf('.');
	if (skille < 0) return null;
	const id = raw.slice(0, skille);
	const token = raw.slice(skille + 1);

	// Sesjonen må tilhøre en bruker i virksomheten forespørselen gjelder. En
	// gyldig sesjonscookie fra ett legekontor skal ikke virke hos et annet.
	const row = await one<Session & { token_hash: string }>(
		`SELECT s.id, s.user_id, s.created_at, s.last_active, s.expires_at, s.amr, s.elevated_until, s.ip, s.token_hash
		 FROM user_session s
		 JOIN user_account u ON u.id = s.user_id
		 WHERE s.id = $1 AND s.ended = false AND u.tenant_id IS NOT DISTINCT FROM $2`,
		[id, requireTenant().id]
	);
	if (!row) return null;
	if (!likeStrenger(row.token_hash, tokenHash(token))) {
		// Gyldig sesjons-id med feil token: mulig tyveri av cookie. Avslutt sesjonen.
		await exec('UPDATE user_session SET ended = true WHERE id = $1', [id]);
		return null;
	}
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await exec('UPDATE user_session SET ended = true WHERE id = $1', [id]);
		return null;
	}
	const inactiveMs = Date.now() - new Date(row.last_active).getTime();
	if (inactiveMs > config.session.idleSeconds * 1000) {
		await exec('UPDATE user_session SET ended = true WHERE id = $1', [id]);
		return null;
	}
	await exec('UPDATE user_session SET last_active = now() WHERE id = $1', [id]);
	return row;
}

export async function endSession(cookies: Cookies): Promise<void> {
	const raw = cookies.get(config.session.cookieName);
	if (raw) {
		const id = raw.split('.')[0];
		await exec('UPDATE user_session SET ended = true WHERE id = $1', [id]);
	}
	cookies.delete(config.session.cookieName, { path: '/' });
}

/** Markerer sesjonen som nylig reautentisert (step-up), f.eks. før nødrett. */
export async function elevateSession(sessionId: string): Promise<string> {
	const to = new Date(Date.now() + config.session.elevationSeconds * 1000).toISOString();
	await exec('UPDATE user_session SET elevated_until = $2 WHERE id = $1', [sessionId, to]);
	return to;
}

export async function endAllSessions(userId: string): Promise<number> {
	return exec('UPDATE user_session SET ended = true WHERE user_id = $1 AND ended = false', [userId]);
}

/** Vedlikehold. Går bevisst på tvers av virksomheter: sletter bare utløpte rader. */
export async function purgeUtlopteSessions(): Promise<number> {
	return exec("DELETE FROM user_session WHERE expires_at < now() - interval '30 days'");
}
