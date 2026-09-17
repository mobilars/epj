import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { developerFromSession } from '$srv/developer/developer';
import { config } from '$srv/config';
import { SEARCH_PARAMS } from '$srv/fhir/searchparams';
import { ICPC2 } from '$srv/terminology/icpc2';
import { SYSTEM } from '$srv/fhir/codesystems';

/**
 * The API reference, built from the code that answers it.
 *
 * The list of resource types comes from the same table the gateway checks, so
 * the page cannot say a type is supported that the gateway would refuse. The
 * terminology edition is the one bundled. Nothing here is typed in twice.
 */
export const load: PageServerLoad = async (event) => {
	if (!(await developerFromSession(event.cookies))) redirect(303, '/utvikler/logg-inn');
	const base = config.baseUrl.replace(/\/$/, '');
	const types = Object.keys(SEARCH_PARAMS)
		.filter((t) => t !== 'Binary')
		.sort((a, b) => a.localeCompare(b));
	return {
		base,
		fhir: `${base}/fhir`,
		wellKnown: `${base}/fhir/.well-known/smart-configuration`,
		jwks: `${base}/oauth/jwks`,
		cds: `${base}/cds-services`,
		types,
		icpc2: { url: SYSTEM.ICPC2, version: ICPC2.version, count: ICPC2.count }
	};
};
