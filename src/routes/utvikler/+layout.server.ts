import type { LayoutServerLoad } from './$types';
import { developerFromSession } from '$srv/developer/developer';

/**
 * The developer portal.
 *
 * A world of its own: no organisation, no role, no patient. What a developer
 * can see is their own apps and what the platform has said about them.
 */
export const load: LayoutServerLoad = async (event) => {
	const developer = await developerFromSession(event.cookies);
	return {
		developer: developer
			? { email: developer.email, name: developer.name, organisation: developer.organisation }
			: null
	};
};
