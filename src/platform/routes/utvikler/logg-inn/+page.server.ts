import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	completeLogin,
	developerFromSession,
	endDeveloperSession,
	requestLoginCode,
	validEmail
} from '$srv/developer/developer';
import { rateLimit } from '$srv/http';
import { VERSION, hasAcceptedCurrent, recordAcceptance } from '$srv/developer/terms';

/**
 * Signing in to the developer portal.
 *
 * A code to the address, and nothing else. No password means nothing to leak,
 * nothing to reuse from another site, and nothing to reset - and what it
 * proves, that the person reads mail at the address their apps are registered
 * to, is the same thing that matters when an app has to be revoked in a hurry.
 *
 * The account is created on the first successful sign-in. There is no separate
 * registration step to confirm, and therefore no half-created accounts.
 */
export const load: PageServerLoad = async (event) => {
	if (await developerFromSession(event.cookies)) redirect(303, '/utvikler');
	return {
		sent: event.url.searchParams.get('sendt') === 'ja',
		email: event.url.searchParams.get('e') ?? '',
		termsVersion: VERSION
	};
};

export const actions: Actions = {
	send: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('epost') ?? '').trim();
		if (!validEmail(email)) return fail(400, { error: 'Skriv inn en gyldig e-postadresse.', email });

		// Asked before the code is sent, not after. Signing in creates the account
		// on first use, so this is the only moment before there is one - and a
		// consent collected after the fact is not a consent.
		if (form.get('vilkar') !== 'godtatt') {
			return fail(400, { error: 'Du må godta utviklervilkårene for å opprette konto.', email });
		}

		// Per address and per caller: this endpoint sends mail to whoever is
		// named, so it has to be expensive to use as a way of sending mail.
		const limit = await rateLimit(`utvikler:${email.toLowerCase()}`, 5, 900);
		if (!limit.allowed) return fail(429, { error: 'For mange forespørsler. Vent litt.', email });

		try {
			await requestLoginCode(email, event.locals.clientIp);
		} catch (err) {
			return fail(500, { error: `Klarte ikke å sende koden: ${(err as Error).message}`, email });
		}
		// The same answer whether or not the address is known: a portal that says
		// which addresses have accounts is a list of who builds what.
		redirect(303, `/utvikler/logg-inn?sendt=ja&e=${encodeURIComponent(email)}`);
	},

	bekreft: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('epost') ?? '').trim();
		const code = String(form.get('kode') ?? '').trim();

		const limit = await rateLimit(`utvikler-kode:${event.locals.clientIp}`, 20, 900);
		if (!limit.allowed) return fail(429, { error: 'For mange forsøk. Vent litt.', email, sent: true });

		const result = await completeLogin(
			email,
			code,
			event.cookies,
			event.locals.clientIp,
			event.request.headers.get('user-agent')
		);
		if (!result.ok) return fail(400, { error: result.error, email, sent: true });

		// The acceptance is recorded against the account the code just created or
		// unlocked, with the version and the address it came from.
		if (form.get('vilkar') === 'godtatt' && !(await hasAcceptedCurrent(result.developer.id))) {
			await recordAcceptance(result.developer.id, event.locals.clientIp);
		}
		redirect(303, '/utvikler');
	},

	loggUt: async (event) => {
		await endDeveloperSession(event.cookies);
		redirect(303, '/utvikler/logg-inn');
	}
};
