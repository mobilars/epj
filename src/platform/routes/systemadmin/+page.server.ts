import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createTenant, setTenantstatus, tenantOverview } from '$srv/tenant/tenant';
import { partitioningWorks } from '$srv/tenant/partition';
import { actorFromContext } from '$srv/audit';
import { config } from '$srv/config';
import { PLATFORM_TENANT } from '$srv/tenant/context';

/**
 * The organisation register seen from the platform.
 *
 * The overview counts users and log entries per organisation, and checks them
 * against the partitions HAPI actually has. A discrepancy between the two
 * registers is an operational fault that must show, not be hidden.
 */
export const load: PageServerLoad = async () => {
	const [overview, partitioning] = await Promise.all([
		tenantOverview(),
		partitioningWorks()
	]);

	return {
		partitioning,
		multitenant: config.fhirServer.multitenant,
		defaultTenant: config.tenant.defaultValue,
		organisations: overview.map((t) => ({
			id: t.id,
			name: t.name,
			organisation_number: t.organisation_number,
			herId: t.her_id,
			hostname: t.hostname,
			baseUrl: t.base_url,
			partitionId: t.partition_id,
			status: t.status,
			note: t.note,
			isPlatform: t.id === PLATFORM_TENANT,
			countUsers: t.countUsers,
			countAuditEntry: t.countAuditEntry,
			lastAktivitet: t.lastAktivitet ? new Date(t.lastAktivitet).toLocaleString('nb-NO') : null,
			partitionExists: t.partitionExists,
			created_at: new Date(t.created_at).toLocaleDateString('nb-NO')
		}))
	};
};

/** Accepts `example.no` as well as `https://example.no`. */
function medProtokoll(value: string): string {
	const trimmed = value.trim().replace(/\/$/, '');
	if (!trimmed) return trimmed;
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const actions: Actions = {
	create: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const text = (n: string) => String(form.get(n) ?? '').trim();

		// Handed back on failure so the form can fill itself in again.
		const values = Object.fromEntries(
			['id', 'navn', 'organisasjonsnummer', 'herId', 'kommunenummer', 'vertsnavn', 'baseUrl', 'merknad',
				'adminBrukernavn', 'adminNavn', 'adminFodselsnummer', 'adminEpost'].map((f) => [f, text(f)])
		);

		const result = await createTenant(
			{
				id: text('id').toLowerCase(),
				name: text('navn'),
				organisation_number: text('organisasjonsnummer').replace(/\s/g, ''),
				herId: text('herId') || undefined,
				municipality_code: text('kommunenummer') || undefined,
				hostname: text('vertsnavn').toLowerCase() || undefined,
				// A bare hostname is what people type. Anything without a scheme gets
				// https, so the form does not reject `legekontoret.apps.apus.no`.
				// Empty means the shared address. A practice only gets one of its own
				// when somebody has added the hostname to the ingress and the
				// certificate - there is no wildcard certificate here, so a name
				// nobody added is a name that does not answer.
				baseUrl: medProtokoll(text('baseUrl')) || config.baseUrl.replace(/\/$/, ''),
				note: text('merknad') || undefined,
				adminUsername: text('adminBrukernavn') || undefined,
				adminName: text('adminNavn') || undefined,
				adminNationalId: text('adminFodselsnummer').replace(/\s/g, '') || undefined,
				adminEmail: text('adminEpost') || undefined
			},
			actorFromContext(ctx)
		);

		if (!result.ok) return fail(400, { error: result.error, values });
		return {
			created_at: result.tenant.id,
			adminUsername: result.adminUsername,
			temporaryPassword: result.temporaryPassword
		};
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const status = String(form.get('status') ?? '');

		if (id === PLATFORM_TENANT) {
			return fail(400, { error: 'Plattformvirksomheten kan ikke suspenderes - da stenges dette grensesnittet ute.' });
		}
		if (status !== 'aktiv' && status !== 'suspendert' && status !== 'avviklet') {
			return fail(400, { error: 'Ukjent status.' });
		}

		await setTenantstatus(id, status, actorFromContext(ctx));
		return { statusSatt: `${id}: ${status}` };
	}
};
