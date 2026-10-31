import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { config } from '$srv/config';
import { appsWithStatus } from '$srv/developer/catalogue';

/**
 * Platform administration.
 *
 * This is the only interface that looks across organisations. It grants no
 * clinical access: the `systemeier` role has no scopes, so the FHIR gate
 * refuses it whatever might be written here.
 */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.permissions.has('plattform:administrer')) {
		error(403, 'Bare systemeier har tilgang til plattformadministrasjonen.');
	}
	// Apps waiting for someone here to review them. Shown on the tab, because
	// a developer waiting on a decision should not depend on someone happening
	// to open the right page.
	const waitingApps = (await appsWithStatus('til-vurdering')).length;

	return {
		waitingApps,
		platformHostname: config.tenant.platformHostname,
		egetHostname: event.url.hostname
	};
};
