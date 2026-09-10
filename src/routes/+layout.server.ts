import type { LayoutServerLoad } from './$types';
import { config } from '$srv/config';
import { ROLE_DEFINISJONER } from '$srv/authz/roles';
import { listClients } from '$srv/auth/clients';

/** Data shared by the whole application: who is signed in, and in which environment. */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;

	/**
	 * The apps that can be started from the menu.
	 *
	 * Only those with a launch URL: an app without one cannot be started from
	 * the record at all. The ones marked for the main menu sit there directly;
	 * the rest live under a dropdown, so a practice with many apps does not push
	 * the record's own pages off the bar.
	 */
	const apps =
		ctx?.permissions.has('journal:les')
			? (await listClients())
					.filter((c) => c.status === 'aktiv' && c.launch_url && c.client_category !== 'backend')
					.map((c) => ({ clientId: c.client_id, name: c.name, inMainMenu: c.in_main_menu }))
			: [];

	return {
		apps,
		user: ctx
			? {
					name: ctx.name,
					roles: ctx.roles,
					rollenavn: ctx.roles.map((r) => ROLE_DEFINISJONER[r]?.name ?? r),
					permissions: [...ctx.permissions],
					mate: ctx.mate,
					amr: ctx.amr
				}
			: null,
		organisation: config.organisation.name,
		miljo: {
			integrations: config.integrations.mode,
			testLogin: config.testLogin.aktivert,
			produksjon: process.env.NODE_ENV === 'production'
		}
	};
};
