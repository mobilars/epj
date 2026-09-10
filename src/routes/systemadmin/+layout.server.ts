import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { config } from '$srv/config';

/**
 * Plattformadministrasjon.
 *
 * Dette er det eneste grensesnittet som ser på tvers av virksomheter. Det gir
 * ingen klinisk tilgang: rollen `systemeier` har ingen scopes, så FHIR-porten
 * avviser den uansett hva som skulle stå her.
 */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.permissions.has('plattform:administrer')) {
		error(403, 'Bare systemeier har tilgang til plattformadministrasjonen.');
	}
	return {
		platformHostname: config.tenant.platformHostname,
		egetHostname: event.url.hostname
	};
};
