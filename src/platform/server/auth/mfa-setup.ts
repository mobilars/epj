import type { Cookies } from '@sveltejs/kit';
import { config } from '../config';
import { decrypt, encrypt } from '../util/crypto';
import { newTotpSecret } from './totp';

/**
 * The half-finished state of a two-factor enrolment.
 *
 * It lives in an encrypted cookie rather than in the database: the secret is
 * only worth storing once an authenticator has proved it holds it, and an
 * abandoned enrolment should leave nothing behind. The password has already
 * been checked when this is created, so the cookie is what carries that fact
 * the short distance to the setup page.
 */

const COOKIE = 'epj_mfa_oppsett';
const TTL_SECONDS = 600;

export interface MfaSetup {
	userId: string;
	secret: string;
	returnTo: string;
	created_at: number;
}

export function startMfaSetup(cookies: Cookies, userId: string, returnTo: string): void {
	const setup: MfaSetup = { userId, secret: newTotpSecret(), returnTo, created_at: Date.now() };
	cookies.set(COOKIE, encrypt(JSON.stringify(setup)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: config.security.httpsOnly,
		maxAge: TTL_SECONDS
	});
}

export function readMfaSetup(cookies: Cookies): MfaSetup | null {
	const raw = cookies.get(COOKIE);
	if (!raw) return null;
	try {
		const setup = JSON.parse(decrypt(raw)) as MfaSetup;
		if (Date.now() - setup.created_at > TTL_SECONDS * 1000) return null;
		return setup;
	} catch {
		return null;
	}
}

export function endMfaSetup(cookies: Cookies): void {
	cookies.delete(COOKIE, { path: '/' });
}
