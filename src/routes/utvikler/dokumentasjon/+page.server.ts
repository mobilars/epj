import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { developerFromSession } from '$srv/developer/developer';
import { config } from '$srv/config';

/** What a developer needs in order to build against this record. */
export const load: PageServerLoad = async (event) => {
	if (!(await developerFromSession(event.cookies))) redirect(303, '/utvikler/logg-inn');
	const base = config.baseUrl.replace(/\/$/, '');
	return { base, fhir: `${base}/fhir`, wellKnown: `${base}/fhir/.well-known/smart-configuration` };
};
