import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/** Administration requires its own permissions, and grants no clinical insight. */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	const has = (r: string) => ctx.permissions.has(r as never);
	if (!has('admin:brukere') && !has('admin:apper') && !has('admin:logg')) {
		error(403, 'Rollen din har ikke administrasjonstilgang.');
	}
	return {
		canUsers: has('admin:brukere'),
		canApper: has('admin:apper'),
		canLog: has('admin:logg') || has('logg:innsyn'),
		canSystem: has('admin:system')
	};
};
