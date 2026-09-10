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
 * Sign-in sessions for the record's own UI.
 *
 * The cookie is HttpOnly, SameSite=Strict and Secure outside local development,
 * and holds only a random token - never user data. The session has both an idle
 * limit and an absolute lifetime.
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
		/**
		 * `lax`, not `strict`.
		 *
		 * The return from HelseID is a navigation begun on another site, and
		 * browsers withhold a Strict cookie on every request in such a chain. The
		 * first page after a successful sign-in therefore arrived without the
		 * session and bounced the user back to the sign-in page; signing in again
		 * - now a same-site navigation - worked, which made it look intermittent.
		 *
		 * `lax` still keeps the cookie off cross-site POSTs, and SvelteKit checks
		 * the Origin header on form submissions besides.
		 */
		sameSite: 'lax',
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

	// The session must belong to a user in the organisation the request concerns.
	// A valid session cookie from one practice must not work at another.
	const row = await one<Session & { token_hash: string }>(
		`SELECT s.id, s.user_id, s.created_at, s.last_active, s.expires_at, s.amr, s.elevated_until, s.ip, s.token_hash
		 FROM user_session s
		 JOIN user_account u ON u.id = s.user_id
		 WHERE s.id = $1 AND s.ended = false AND u.tenant_id IS NOT DISTINCT FROM $2`,
		[id, requireTenant().id]
	);
	if (!row) return null;
	if (!likeStrenger(row.token_hash, tokenHash(token))) {
		// Valid session id with the wrong token: possible cookie theft. End it.
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

/** Marks the session as recently re-authenticated (step-up), e.g. before emergency access. */
export async function elevateSession(sessionId: string): Promise<string> {
	const to = new Date(Date.now() + config.session.elevationSeconds * 1000).toISOString();
	await exec('UPDATE user_session SET elevated_until = $2 WHERE id = $1', [sessionId, to]);
	return to;
}

export async function endAllSessions(userId: string): Promise<number> {
	return exec('UPDATE user_session SET ended = true WHERE user_id = $1 AND ended = false', [userId]);
}

/** Maintenance. Deliberately across organisations: deletes only expired rows. */
export async function purgeUtlopteSessions(): Promise<number> {
	return exec("DELETE FROM user_session WHERE expires_at < now() - interval '30 days'");
}

/**
 * The organisation a session belongs to, without knowing it first.
 *
 * Every other lookup in the record is bounded to one organisation, and this
 * one deliberately is not - it exists for the shared trial hostname, where
 * there is no hostname to derive the organisation from and it has to come from
 * whose session this is instead.
 *
 * It reads no session data and grants nothing: it answers only "which
 * organisation", and the session is then verified inside that organisation by
 * `getSession` exactly as on any other hostname. A forged or expired cookie
 * gets no further here than it does anywhere else.
 */
export async function tenantIdForSession(cookies: Cookies): Promise<string | null> {
	const raw = cookies.get(config.session.cookieName);
	if (!raw) return null;
	const separator = raw.indexOf('.');
	if (separator < 0) return null;

	const row = await one<{ tenant_id: string }>(
		`SELECT u.tenant_id FROM user_session s JOIN user_account u ON u.id = s.user_id
		 WHERE s.id = $1 AND s.expires_at > now()`,
		[raw.slice(0, separator)]
	);
	return row?.tenant_id ?? null;
}
