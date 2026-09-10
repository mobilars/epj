import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listUsers, createUser, setPassword, setRoles, setStatus } from '$srv/auth/users';
import { endAllSessions } from '$srv/auth/session';
import { revokeForUser } from '$srv/auth/tokens';
import { isRole, ROLE_DEFINISJONER, ROLES } from '$srv/authz/roles';
import { log, actorFromContext } from '$srv/audit';
import { newToken } from '$srv/util/ids';

/** Brukeradministrasjon. Alle endringer i roller og status loggføres. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('admin:brukere')) error(403, 'Ingen tilgang.');
	return {
		users: (await listUsers()).map((b) => ({
			id: b.id,
			username: b.username,
			name: b.name,
			hpr: b.hpr_number,
			roles: b.roles,
			status: b.status,
			mfa: b.mfa_aktivert,
			lastLogin: b.last_login ? new Date(b.last_login).toLocaleString('nb-NO') : null,
			locked: b.locked_until ? new Date(b.locked_until) > new Date() : false
		})),
		roles: ROLES.map((r) => ({ code: r, name: ROLE_DEFINISJONER[r].name, description: ROLE_DEFINISJONER[r].description }))
	};
};

export const actions: Actions = {
	create: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:brukere')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const roles = form.getAll('roller').map(String).filter(isRole);
		const username = String(form.get('brukernavn') ?? '').trim();
		if (!username) return fail(400, { error: 'Brukernavn må fylles ut.' });

		const temporary = newToken(9);
		const user = await createUser({
			username,
			name: String(form.get('navn') ?? '').trim() || username,
			email: String(form.get('epost') ?? '').trim() || undefined,
			hprNumber: String(form.get('hpr') ?? '').trim() || undefined,
			practitionerId: String(form.get('practitionerId') ?? '').trim() || undefined,
			password: temporary,
			roles,
			createdOf: ctx.userId ?? undefined
		});
		await log(
			{ type: 'admin', subtype: 'bruker:opprettet', action: 'C', outcome: '0', entityRef: `Person/${user.id}`, details: { username, roles: roles.join(',') } },
			actorFromContext(ctx)
		);
		return { ok: true, temporaryPassword: temporary, username };
	},

	roles: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:brukere')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const userId = String(form.get('id') ?? '');
		const roles = form.getAll('roller').map(String).filter(isRole);
		await setRoles(userId, roles, ctx.userId ?? 'ukjent');
		await log(
			{ type: 'admin', subtype: 'bruker:roller', action: 'U', outcome: '0', entityRef: `Person/${userId}`, details: { roles: roles.join(',') } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/brukere');
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:brukere')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const userId = String(form.get('id') ?? '');
		const status = String(form.get('status') ?? 'aktiv') as 'aktiv' | 'sperret' | 'avsluttet';
		await setStatus(userId, status);
		if (status !== 'aktiv') {
			await endAllSessions(userId);
			await revokeForUser(userId, `status satt til ${status}`);
		}
		await log(
			{ type: 'admin', subtype: 'bruker:status', action: 'U', outcome: '0', entityRef: `Person/${userId}`, details: { status } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/brukere');
	},

	newPassword: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:brukere')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const userId = String(form.get('id') ?? '');
		const temporary = newToken(9);
		await setPassword(userId, temporary, true);
		await endAllSessions(userId);
		await log(
			{ type: 'admin', subtype: 'bruker:passord', action: 'U', outcome: '0', entityRef: `Person/${userId}` },
			actorFromContext(ctx)
		);
		return { ok: true, temporaryPassword: temporary };
	}
};
