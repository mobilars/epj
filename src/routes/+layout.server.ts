import type { LayoutServerLoad } from './$types';
import { config } from '$srv/config';
import { ROLE_DEFINISJONER } from '$srv/authz/roles';
import { listClients } from '$srv/auth/clients';
import { recentPatients } from '$srv/journal/recent';
import { SETTING, getSetting } from '$srv/auth/settings';

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
					.map((c) => ({ clientId: c.client_id, name: c.name, inMainMenu: c.in_main_menu, inPatientTabs: c.in_patient_tabs, openInNewTab: c.open_in_new_tab }))
			: [];

	/**
	 * The patients this user has had open lately.
	 *
	 * Read out of the audit log rather than kept in a list of its own: every
	 * lookup is written there already, and a second record of who looked at whom
	 * would be one more place holding that fact. It is also self-correcting - a
	 * relationship that ends stops appearing as soon as the lookups stop.
	 *
	 * Names come from FHIR through the ordinary guard, so a patient the user may
	 * no longer see simply does not appear.
	 */
	const recent = ctx?.userId && ctx.permissions.has('journal:les') ? await recentPatients(ctx) : [];

	// On unless the user has turned them off.
	const shortcuts = ctx?.userId ? (await getSetting(ctx.userId, SETTING.SHORTCUTS)) !== 'off' : false;

	return {
		apps,
		recentPatients: recent,
		shortcuts,
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
