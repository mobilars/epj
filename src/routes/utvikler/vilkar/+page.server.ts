import type { PageServerLoad } from './$types';
import { TERMS, acceptedVersion } from '$srv/developer/terms';
import { developerFromSession } from '$srv/developer/developer';

/**
 * The terms, readable by anyone.
 *
 * Deliberately not behind the sign-in: somebody deciding whether to build
 * against this record should be able to read what they would be agreeing to
 * before handing over an address.
 */
export const load: PageServerLoad = async (event) => {
	const developer = await developerFromSession(event.cookies);
	return {
		terms: TERMS,
		accepted: developer ? await acceptedVersion(developer.id) : null
	};
};
