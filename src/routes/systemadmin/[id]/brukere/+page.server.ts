import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTenant } from '$srv/tenant/tenant';
import { PLATFORM_TENANT, withTenant } from '$srv/tenant/context';
import { createUser, listUsers, setPassword, setRoles, setStatus } from '$srv/auth/users';
import { endAllSessions } from '$srv/auth/session';
import { revokeForUser } from '$srv/auth/tokens';
import { isPlatformRole, isRole, ROLE_DEFINISJONER, ROLES, TENANT_ROLES, type Role } from '$srv/authz/roles';
import { validNorwegianNationalId } from '$srv/fhir/codesystems';
import { log, actorFromContext } from '$srv/audit';
import { exec } from '$srv/db';
import { newToken } from '$srv/util/ids';

/**
 * Users in one organisation, seen from the platform.
 *
 * The platform administrator has no access to patient data anywhere, and none
 * is shown here - this is the register of who may sign in, and with which
 * role. It exists because an organisation can lose its own administrator: if
 * the only account holding `admin:brukere` is locked out, nobody inside the
 * practice can put that right, and the platform is the only place left.
 *
 * Every change is written to the audit log of the organisation it concerns,
 * marked as coming from the platform, so it is visible from inside the
 * practice rather than only from above.
 */

async function tenantFor(id: string) {
	const tenant = await getTenant(id);
	if (!tenant) error(404, 'Ukjent virksomhet.');
	return tenant;
}

/** Platform roles belong to the platform organisation, and nowhere else. */
function allowedRoles(tenantId: string): readonly Role[] {
	return tenantId === PLATFORM_TENANT ? ROLES : TENANT_ROLES;
}

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');
	const tenant = await tenantFor(event.params.id);

	const users = await withTenant(tenant, () => listUsers());
	return {
		organisation: { id: tenant.id, name: tenant.name },
		roles: allowedRoles(tenant.id).map((r) => ({
			code: r,
			name: ROLE_DEFINISJONER[r].name,
			description: ROLE_DEFINISJONER[r].description
		})),
		users: users.map((u) => ({
			id: u.id,
			username: u.username,
			name: u.name,
			hpr: u.hpr_number,
			roles: u.roles as string[],
			status: u.status,
			mfa: u.mfa_aktivert,
			lastLogin: u.last_login ? new Date(u.last_login).toLocaleString('nb-NO') : null
		}))
	};
};

export const actions: Actions = {
	create: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');
		const tenant = await tenantFor(event.params.id);
		const form = await event.request.formData();
		const values = Object.fromEntries(
			['brukernavn', 'navn', 'epost', 'hpr', 'fodselsnummer'].map((f) => [f, String(form.get(f) ?? '')])
		);

		return withTenant(tenant, async () => {
			const roles = form.getAll('roller').map(String).filter(isRole);
			if (tenant.id !== PLATFORM_TENANT && roles.some(isPlatformRole)) {
				return fail(400, { error: 'Plattformroller hører til plattformvirksomheten.', values });
			}
			const username = String(form.get('brukernavn') ?? '').trim();
			if (!username) return fail(400, { error: 'Brukernavn må fylles ut.', values });

			const nationalId = String(form.get('fodselsnummer') ?? '').replace(/\s/g, '');
			if (nationalId && !validNorwegianNationalId(nationalId)) {
				return fail(400, { error: 'Ugyldig fødselsnummer (kontrollsiffer stemmer ikke).', values });
			}

			const temporary = newToken(9);
			const user = await createUser({
				username,
				name: String(form.get('navn') ?? '').trim() || username,
				email: String(form.get('epost') ?? '').trim() || undefined,
				hprNumber: String(form.get('hpr') ?? '').trim() || undefined,
				nationalId: nationalId || undefined,
				password: temporary,
				roles,
				createdOf: ctx.userId ?? undefined
			});
			await log(
				{
					type: 'admin',
					subtype: 'bruker:opprettet',
					action: 'C',
					outcome: '0',
					entityRef: `Person/${user.id}`,
					details: { username, roles: roles.join(','), fraPlattform: true }
				},
				actorFromContext(ctx)
			);
			return { ok: true, temporaryPassword: temporary, username };
		});
	},

	roles: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');
		const tenant = await tenantFor(event.params.id);
		const form = await event.request.formData();

		const result = await withTenant(tenant, async () => {
			const userId = String(form.get('id') ?? '');
			const roles = form.getAll('roller').map(String).filter(isRole);
			if (tenant.id !== PLATFORM_TENANT && roles.some(isPlatformRole)) {
				return fail(400, { error: 'Plattformroller hører til plattformvirksomheten.' });
			}
			await setRoles(userId, roles, ctx.userId ?? 'plattform');
			await log(
				{
					type: 'admin',
					subtype: 'bruker:roller',
					action: 'U',
					outcome: '0',
					entityRef: `Person/${userId}`,
					details: { roles: roles.join(','), fraPlattform: true }
				},
				actorFromContext(ctx)
			);
			return null;
		});
		if (result) return result;
		redirect(303, `/systemadmin/${tenant.id}/brukere`);
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');
		const tenant = await tenantFor(event.params.id);
		const form = await event.request.formData();

		await withTenant(tenant, async () => {
			const userId = String(form.get('id') ?? '');
			const status = String(form.get('status') ?? 'aktiv') as 'aktiv' | 'sperret' | 'avsluttet';
			await setStatus(userId, status);
			if (status !== 'aktiv') {
				await endAllSessions(userId);
				await revokeForUser(userId, `status satt til ${status}`);
			}
			await log(
				{
					type: 'admin',
					subtype: 'bruker:status',
					action: 'U',
					outcome: '0',
					entityRef: `Person/${userId}`,
					details: { status, fraPlattform: true }
				},
				actorFromContext(ctx)
			);
		});
		redirect(303, `/systemadmin/${tenant.id}/brukere`);
	},

	newPassword: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');
		const tenant = await tenantFor(event.params.id);
		const form = await event.request.formData();

		return withTenant(tenant, async () => {
			const userId = String(form.get('id') ?? '');
			const temporary = newToken(9);
			await setPassword(userId, temporary, true);
			// A new password on its own leaves any open session alive, and the point
			// of resetting one is usually that it should not be.
			await endAllSessions(userId);
			await log(
				{
					type: 'admin',
					subtype: 'bruker:passord',
					action: 'U',
					outcome: '0',
					entityRef: `Person/${userId}`,
					details: { fraPlattform: true }
				},
				actorFromContext(ctx)
			);
			return { ok: true, temporaryPassword: temporary, username: String(form.get('brukernavn') ?? '') };
		});
	},

	/**
	 * Clears the authenticator so the user enrols a new one on next sign-in.
	 * The everyday case is a lost or replaced phone, which would otherwise lock
	 * the account for good.
	 */
	nullstillMfa: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');
		const tenant = await tenantFor(event.params.id);
		const form = await event.request.formData();

		await withTenant(tenant, async () => {
			const userId = String(form.get('id') ?? '');
			await exec(
				'UPDATE user_account SET totp_secret_enc = NULL, mfa_aktivert = false, updated_at = now() WHERE id = $1 AND tenant_id = $2',
				[userId, tenant.id]
			);
			await endAllSessions(userId);
			await log(
				{
					type: 'admin',
					subtype: 'bruker:mfa-nullstilt',
					action: 'U',
					outcome: '0',
					entityRef: `Person/${userId}`,
					details: { fraPlattform: true }
				},
				actorFromContext(ctx)
			);
		});
		redirect(303, `/systemadmin/${tenant.id}/brukere`);
	}
};
