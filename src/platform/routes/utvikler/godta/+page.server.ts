import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { developerFromSession } from '$srv/developer/developer';
import { TERMS, acceptedVersion, hasAcceptedCurrent, recordAcceptance } from '$srv/developer/terms';

/**
 * Accepting terms that have changed since last time.
 *
 * A developer who agreed to an older version is stopped here rather than
 * quietly carried along. What they agreed to was that text, and if it now says
 * something different they should be asked again - which also means the terms
 * can be tightened without pretending everyone already agreed to the tightening.
 */
export const load: PageServerLoad = async (event) => {
	const developer = await developerFromSession(event.cookies);
	if (!developer) redirect(303, '/utvikler/logg-inn');
	if (await hasAcceptedCurrent(developer.id)) redirect(303, '/utvikler');
	return { terms: TERMS, previous: await acceptedVersion(developer.id) };
};

export const actions: Actions = {
	default: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		if (form.get('vilkar') !== 'godtatt') {
			return fail(400, { error: 'Du må godta vilkårene for å fortsette.' });
		}
		await recordAcceptance(developer.id, event.locals.clientIp);
		redirect(303, '/utvikler');
	}
};
