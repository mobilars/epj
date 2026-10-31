import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { exec, one, query } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { newId } from '$srv/util/ids';
import { log, actorFromContext } from '$srv/audit';
import { listUsers } from '$srv/auth/users';
import { ROLES, ROLE_DEFINISJONER, type Role } from '$srv/authz/roles';

/**
 * Restrictions on the record ("sperring").
 *
 * A patient may demand that the record, or parts of it, is kept from named
 * health personnel or from everyone (the Patient Records Act section 17, the
 * Health Personnel Act section 25). The restriction is then the patient's
 * decision; what the practice does is register it faithfully and lift it only
 * when the patient says so. Both are logged with who did it and why, and the
 * patient can see the entries in the access log.
 *
 * The page works whether or not the user can read the record: managing a
 * restriction is not reading, and a restriction against everyone would
 * otherwise be one nobody could lift.
 */

interface RestrictionRow {
	id: string;
	scope_extent: string;
	target_user_id: string | null;
	target_role: string | null;
	target_resource: string | null;
	justification: string | null;
	registered_at: string;
	registered_by: string;
	valid_until: string | null;
	lifted: boolean;
}

const STAFF_ROLES: Role[] = ROLES.filter((r) => r !== 'pasient' && r !== 'systemeier');

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, '/logg-inn');
	if (!ctx.permissions.has('pasient:sperr')) error(403, 'Rollen din kan ikke registrere sperringer.');
	const patientId = event.params.id;
	const tenantId = requireTenant().id;

	const [rows, users] = await Promise.all([
		query<RestrictionRow>(
			`SELECT id, scope_extent, target_user_id, target_role, target_resource, justification,
				registered_at, registered_by, valid_until, lifted
			 FROM record_restriction WHERE patient_id = $1 AND tenant_id = $2
			 ORDER BY lifted, registered_at DESC`,
			[patientId, tenantId]
		),
		listUsers()
	]);
	const userName = new Map(users.map((u) => [u.id, u.name]));
	const roleName = (r: string | null) => (r && r in ROLE_DEFINISJONER ? ROLE_DEFINISJONER[r as Role].name : r ?? '');

	const describe = (r: RestrictionRow) => {
		switch (r.scope_extent) {
			case 'alle':
				return 'Hele journalen, for alle';
			case 'bruker':
				return `Hele journalen, for ${userName.get(r.target_user_id ?? '') ?? r.target_user_id}`;
			case 'rolle':
				return `Hele journalen, for rollen ${roleName(r.target_role)}`;
			case 'dokument':
				return `Dokumentet ${r.target_resource}`;
			default:
				return r.scope_extent;
		}
	};

	return {
		restrictions: rows.map((r) => ({
			id: r.id,
			what: describe(r),
			justification: r.justification ?? '',
			registeredAt: new Date(r.registered_at).toLocaleString('nb-NO'),
			registeredBy: userName.get(r.registered_by) ?? r.registered_by,
			validUntil: r.valid_until ? new Date(r.valid_until).toLocaleDateString('nb-NO') : null,
			lifted: r.lifted
		})),
		users: users.filter((u) => u.roles.some((role) => role !== 'pasient')).map((u) => ({ id: u.id, name: u.name })),
		roles: STAFF_ROLES.map((r) => ({ id: r, name: ROLE_DEFINISJONER[r].name }))
	};
};

export const actions: Actions = {
	register: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('pasient:sperr')) return fail(403, { error: 'Rollen din kan ikke registrere sperringer.' });
		const patientId = event.params.id;
		const form = await event.request.formData();
		const extent = String(form.get('omfang') ?? '');
		const targetUser = String(form.get('bruker') ?? '').trim() || null;
		const targetRole = String(form.get('rolle') ?? '').trim() || null;
		const justification = String(form.get('begrunnelse') ?? '').trim();
		const validUntil = String(form.get('gyldigTil') ?? '').trim() || null;

		if (!['alle', 'bruker', 'rolle'].includes(extent)) return fail(400, { error: 'Velg hvem sperringen gjelder.' });
		if (extent === 'bruker' && !targetUser) return fail(400, { error: 'Velg hvilken bruker sperringen gjelder.' });
		if (extent === 'rolle' && !STAFF_ROLES.includes(targetRole as Role)) {
			return fail(400, { error: 'Velg hvilken rolle sperringen gjelder.' });
		}
		// The justification is the patient's wish as the practice understood it.
		// It is what a later reader - or the patient - will judge the entry by.
		if (justification.length < 10) return fail(400, { error: 'Skriv hva pasienten har bedt om, minst 10 tegn.' });
		if (validUntil && Number.isNaN(Date.parse(validUntil))) return fail(400, { error: 'Ugyldig dato.' });

		const id = newId();
		await exec(
			`INSERT INTO record_restriction (id, tenant_id, patient_id, scope_extent, target_user_id, target_role, justification, registered_by, valid_until)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			[
				id, requireTenant().id, patientId, extent,
				extent === 'bruker' ? targetUser : null, extent === 'rolle' ? targetRole : null,
				justification, ctx.userId, validUntil
			]
		);
		await log(
			{
				type: 'admin', subtype: 'sperring:registrert', action: 'C', outcome: '0', patientId,
				outcomeDescription: justification,
				details: { omfang: extent, bruker: targetUser, rolle: targetRole, gyldigTil: validUntil }
			},
			actorFromContext(ctx)
		);
		redirect(303, `/pasienter/${patientId}/sperring`);
	},

	lift: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('pasient:sperr')) return fail(403, { error: 'Rollen din kan ikke oppheve sperringer.' });
		const patientId = event.params.id;
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const justification = String(form.get('begrunnelse') ?? '').trim();
		if (justification.length < 10) return fail(400, { error: 'Skriv hvorfor sperringen oppheves, minst 10 tegn.' });

		const row = await one<{ scope_extent: string }>(
			'SELECT scope_extent FROM record_restriction WHERE id = $1 AND patient_id = $2 AND tenant_id = $3 AND lifted = false',
			[id, patientId, requireTenant().id]
		);
		if (!row) return fail(404, { error: 'Fant ingen aktiv sperring.' });

		await exec('UPDATE record_restriction SET lifted = true WHERE id = $1 AND tenant_id = $2', [id, requireTenant().id]);
		await log(
			{
				type: 'admin', subtype: 'sperring:opphevet', action: 'U', outcome: '0', patientId,
				outcomeDescription: justification, details: { sperring: id, omfang: row.scope_extent }
			},
			actorFromContext(ctx)
		);
		redirect(303, `/pasienter/${patientId}/sperring`);
	}
};
