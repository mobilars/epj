import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { demoOneTimeCode, demoUsersOffered } from '$srv/auth/demo';

/**
 * The current one-time code for a demo account.
 *
 * The sign-in page uses this to fill in the form when a demo account is
 * clicked. A code computed when the page loaded would already have expired by
 * the time anyone got round to using it; this one is always current.
 *
 * Only ever available where the demo accounts themselves are on display. That
 * flag hands out their password too - the accounts are a convenience in a test
 * environment, not credentials to protect.
 */
export const GET: RequestHandler = async (event) => {
	if (!demoUsersOffered()) error(404, 'Ikke tilgjengelig');
	const code = await demoOneTimeCode(event.url.searchParams.get('brukernavn') ?? '');
	if (!code) error(404, 'Ukjent demobruker');
	return json({ code });
};
