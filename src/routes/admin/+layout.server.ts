import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/** Administrasjon krever egne rettigheter, og gir ikke klinisk innsyn. */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	const har = (r: string) => ctx.rettigheter.has(r as never);
	if (!har('admin:brukere') && !har('admin:apper') && !har('admin:logg')) {
		error(403, 'Rollen din har ikke administrasjonstilgang.');
	}
	return {
		kanBrukere: har('admin:brukere'),
		kanApper: har('admin:apper'),
		kanLogg: har('admin:logg') || har('logg:innsyn')
	};
};
