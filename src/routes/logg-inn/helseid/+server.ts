import { redirect, error, isRedirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { describeOAuthError, isConfigured, startLogin } from '$srv/auth/helseid';
import { log } from '$srv/audit';

/** Starts HelseID sign-in. */
export const GET: RequestHandler = async (event) => {
	if (!isConfigured()) error(503, 'HelseID er ikke konfigurert i dette miljøet');
	const returnTo = event.url.searchParams.get('retur') ?? '/';
	try {
		const url = await startLogin(event.cookies, returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
		redirect(303, url);
	} catch (err) {
		if (isRedirect(err)) throw err;
		// Discovery, the pushed authorization request or the client assertion can
		// fail for reasons the user can do nothing about - a misconfigured client
		// or HelseID being down. Send them back to the sign-in page with a
		// message rather than a stack trace, so the local sign-in is still usable.
		await log(
			{ type: 'login', subtype: 'helseid', action: 'E', outcome: '12', outcomeDescription: describeOAuthError(err) },
			{
				userId: null,
				actorRef: 'Person/ukjent',
				name: 'HelseID',
				role: null,
				clientId: null,
				ip: event.locals.clientIp,
				requestId: event.locals.requestId
			}
		);
		redirect(303, `/logg-inn?feil=${encodeURIComponent('HelseID er utilgjengelig akkurat nå. Prøv igjen, eller logg inn lokalt.')}`);
	}
};
