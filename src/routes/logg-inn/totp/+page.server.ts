import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { activateMfa, getUser, rolesFor } from '$srv/auth/users';
import { createSession } from '$srv/auth/session';
import { newTotpSecret, otpauthUrl } from '$srv/auth/totp';
import { decrypt, encrypt } from '$srv/util/crypto';
import { config } from '$srv/config';
import { log } from '$srv/audit';
import { requireTenant } from '$srv/tenant/context';

/**
 * Setting up two-factor authentication.
 *
 * A new account has no authenticator behind it. When the installation requires
 * two-factor - which it does by default - asking such a user for a code is a
 * dead end: there is nowhere to read one from, and the account cannot be used
 * at all. Every user created from user administration, including the first
 * administrator of a new organisation, was locked out this way.
 *
 * The password has already been checked when the user arrives here. What
 * carries them is a short-lived encrypted cookie holding the account and the
 * proposed secret; the secret is only written to the account once a code
 * computed from it has been shown to work. An abandoned enrolment therefore
 * leaves nothing behind.
 */

const SETUP_COOKIE = 'epj_mfa_oppsett';
const SETUP_TTL_SECONDS = 600;

interface Setup {
	userId: string;
	secret: string;
	returnTo: string;
	created_at: number;
}

/** Called from the sign-in action once the password has been accepted. */
export function startMfaSetup(cookies: import('@sveltejs/kit').Cookies, userId: string, returnTo: string): void {
	const setup: Setup = { userId, secret: newTotpSecret(), returnTo, created_at: Date.now() };
	cookies.set(SETUP_COOKIE, encrypt(JSON.stringify(setup)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: config.security.httpsOnly,
		maxAge: SETUP_TTL_SECONDS
	});
}

function readSetup(cookies: import('@sveltejs/kit').Cookies): Setup | null {
	const raw = cookies.get(SETUP_COOKIE);
	if (!raw) return null;
	try {
		const setup = JSON.parse(decrypt(raw)) as Setup;
		if (Date.now() - setup.created_at > SETUP_TTL_SECONDS * 1000) return null;
		return setup;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async (event) => {
	const setup = readSetup(event.cookies);
	if (!setup) redirect(303, '/logg-inn?feil=Oppsettet%20tok%20for%20lang%20tid.%20Logg%20inn%20p%C3%A5%20nytt.');

	const user = await getUser(setup.userId);
	if (!user) redirect(303, '/logg-inn');

	return {
		username: user.username,
		secret: setup.secret,
		otpauth: otpauthUrl(setup.secret, user.username, requireTenant().name)
	};
};

export const actions: Actions = {
	default: async (event) => {
		const setup = readSetup(event.cookies);
		if (!setup) redirect(303, '/logg-inn?feil=Oppsettet%20tok%20for%20lang%20tid.%20Logg%20inn%20p%C3%A5%20nytt.');

		const form = await event.request.formData();
		const code = String(form.get('engangskode') ?? '').trim();
		if (!code) return fail(400, { error: 'Skriv inn koden fra autentiseringsappen.' });

		// The secret is written to the account only now, and only because a code
		// computed from it verified - which proves the authenticator really holds it.
		if (!(await activateMfa(setup.userId, setup.secret, code))) {
			return fail(400, { error: 'Koden stemmer ikke. Kontroller at klokka på telefonen er riktig, og prøv igjen.' });
		}
		event.cookies.delete(SETUP_COOKIE, { path: '/' });

		const user = await getUser(setup.userId);
		if (!user) redirect(303, '/logg-inn');
		await createSession(user.id, 'pwd+otp', event.locals.clientIp, event.request.headers.get('user-agent'), event.cookies);
		await log(
			{ type: 'login', subtype: 'mfa:oppsett', action: 'U', outcome: '0' },
			{
				userId: user.id,
				actorRef: user.practitioner_id ? `Practitioner/${user.practitioner_id}` : `Person/${user.id}`,
				name: user.name,
				role: (await rolesFor(user.id))[0] ?? null,
				clientId: null,
				ip: event.locals.clientIp,
				requestId: event.locals.requestId
			}
		);
		redirect(303, setup.returnTo);
	}
};
