import type { JWK } from 'jose';
import * as oidc from 'openid-client';
import { dpopHandleFor, helseIdConfiguration, type HelseIdTokens } from './helseid';
import { exec, one, transaction } from '../db';
import { requireTenant } from '../tenant/context';
import { decrypt, encrypt } from '../util/crypto';

/**
 * The signed-in clinician's HelseID token, kept for services that act as them.
 *
 * Encrypted at rest, tied to the session, and never sent to the browser. It is
 * only stored while an app has asked for it (`login-extensions.ts`), and gone when the
 * session is: signing out deletes it, and a session that ended any other way
 * stops it being readable at once and has it swept up at the next sign-in.
 */

/** Renew this long before expiry, so a call never leaves with a dying token. */
const RENEW_MARGIN_MS = 60_000;

interface Stored {
	accessToken: string;
	refreshToken: string | null;
	dpop: { privateJwk: JWK; publicJwk: JWK };
}

export interface HelseIdAccess {
	accessToken: string;
	dpop: oidc.DPoPHandle;
	/** The token changed just now, so whoever holds a session on it has to be told. */
	renewed: boolean;
}

export async function storeHelseIdTokens(sessionId: string, tokens: HelseIdTokens): Promise<void> {
	const stored: Stored = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, dpop: tokens.dpop };
	await exec(
		`DELETE FROM helseid_session_token WHERE session_id IN (
		   SELECT id FROM user_session WHERE ended = true OR expires_at <= now())`
	);
	await exec(
		`INSERT INTO helseid_session_token (session_id, tenant_id, encrypted, expires_at)
		 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
		 ON CONFLICT (session_id) DO UPDATE SET encrypted = EXCLUDED.encrypted, expires_at = EXCLUDED.expires_at, updated_at = now()`,
		[sessionId, requireTenant().id, encrypt(JSON.stringify(stored)), tokens.expiresIn]
	);
}

export async function forgetHelseIdTokens(sessionId: string): Promise<void> {
	await exec('DELETE FROM helseid_session_token WHERE session_id = $1', [sessionId]);
}

/** True when this session has a token. */
export async function hasHelseIdTokens(sessionId: string): Promise<boolean> {
	return Boolean(await readRow(sessionId));
}

async function readRow(sessionId: string, lock = false) {
	return one<{ encrypted: string; expires_at: string }>(
		`SELECT t.encrypted, t.expires_at FROM helseid_session_token t
		 JOIN user_session s ON s.id = t.session_id
		 WHERE t.session_id = $1 AND t.tenant_id = $2 AND s.ended = false AND s.expires_at > now()
		 ${lock ? 'FOR UPDATE OF t' : ''}`,
		[sessionId, requireTenant().id]
	);
}

/**
 * A usable token for the session, renewed if it is about to expire. Null when
 * there is none: signed in some other way, or the renewal was refused and the
 * user has to sign in again.
 *
 * The renewal holds a row lock, because a refresh token is single-use: two tabs
 * renewing at once would otherwise spend it twice.
 */
export async function helseIdAccess(sessionId: string): Promise<HelseIdAccess | null> {
	const row = await readRow(sessionId);
	if (!row) return null;
	if (new Date(row.expires_at).getTime() - Date.now() > RENEW_MARGIN_MS) {
		const stored = JSON.parse(decrypt(row.encrypted)) as Stored;
		const configuration = await helseIdConfiguration();
		return { accessToken: stored.accessToken, dpop: await dpopHandleFor(configuration, stored.dpop), renewed: false };
	}

	return transaction(async () => {
		const locked = await readRow(sessionId, true);
		if (!locked) return null;
		const stored = JSON.parse(decrypt(locked.encrypted)) as Stored;
		const configuration = await helseIdConfiguration();
		const dpop = await dpopHandleFor(configuration, stored.dpop);

		// Someone else renewed while this one waited for the lock.
		if (new Date(locked.expires_at).getTime() - Date.now() > RENEW_MARGIN_MS) {
			return { accessToken: stored.accessToken, dpop, renewed: false };
		}
		if (!stored.refreshToken) return null;

		let tokens: oidc.TokenEndpointResponse;
		try {
			tokens = await oidc.refreshTokenGrant(configuration, stored.refreshToken, undefined, { DPoP: dpop });
		} catch {
			return null;
		}
		const next: Stored = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? stored.refreshToken,
			dpop: stored.dpop
		};
		await exec(
			`UPDATE helseid_session_token SET encrypted = $2, expires_at = now() + make_interval(secs => $3), updated_at = now()
			 WHERE session_id = $1`,
			[sessionId, encrypt(JSON.stringify(next)), tokens.expires_in ?? 60]
		);
		return { accessToken: next.accessToken, dpop, renewed: true };
	});
}
