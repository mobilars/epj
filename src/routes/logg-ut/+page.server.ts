import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { endSession } from '$srv/auth/session';
import { actorFromContext, log } from '$srv/audit';
import { config } from '$srv/config';
import { isConfigured } from '$srv/auth/helseid';

/**
 * Signing out.
 *
 * The session in the record ends here, but the one at HelseID does not: the
 * user is still signed in there, and the next sign-in would go straight
 * through without asking for anything. On a shared machine at a practice that
 * is the difference between having signed out and only appearing to. The page
 * therefore says so, and offers the way to end that session too.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (ctx) {
		await log({ type: 'login', subtype: 'logout', action: 'E', outcome: '0' }, actorFromContext(ctx));
	}
	await endSession(event.cookies);

	// Derived from the issuer, so a test environment points at the test service
	// and production at the real one.
	return {
		healthIdLogoutUrl: isConfigured() ? `${config.integrations.healthId.issuer}/Account/Logout` : null
	};
};

export const actions: Actions = {
	default: async (event) => {
		const ctx = event.locals.auth;
		if (ctx) {
			await log({ type: 'login', subtype: 'logout', action: 'E', outcome: '0' }, actorFromContext(ctx));
		}
		await endSession(event.cookies);
		redirect(303, '/logg-ut');
	}
};
