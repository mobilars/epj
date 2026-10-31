import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { developerFromSession } from '$srv/developer/developer';
import { hasAcceptedCurrent } from '$srv/developer/terms';

/**
 * The developer portal.
 *
 * A world of its own: no organisation, no role, no patient. What a developer
 * can see is their own apps and what the platform has said about them.
 */
export const load: LayoutServerLoad = async (event) => {
	const developer = await developerFromSession(event.cookies);

	// Terms that have changed stop the developer here. The pages that are part
	// of accepting them - and the terms themselves - are the exception, or there
	// would be nowhere to go.
	const exempt = ['/utvikler/godta', '/utvikler/vilkar', '/utvikler/logg-inn'];
	if (developer && !exempt.some((p) => event.url.pathname.startsWith(p))) {
		if (!(await hasAcceptedCurrent(developer.id))) redirect(303, '/utvikler/godta');
	}

	return {
		developer: developer
			? { email: developer.email, name: developer.name, organisation: developer.organisation }
			: null
	};
};
