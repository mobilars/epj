import type { LayoutServerLoad } from './$types';
import { config } from '$srv/config';
import { ROLE_DEFINISJONER } from '$srv/authz/roles';

/** Data shared by the whole application: who is signed in, and in which environment. */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	return {
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
