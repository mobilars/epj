import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createTenant, setTenantstatus, tenantOverview } from '$srv/tenant/tenant';
import { partitioningWorks } from '$srv/tenant/partition';
import { actorFromContext } from '$srv/audit';
import { config } from '$srv/config';
import { PLATFORM_TENANT } from '$srv/tenant/context';

/**
 * Virksomhetsregisteret sett fra plattformen.
 *
 * Oversikten teller brukere og loggeinnslag per virksomhet, og krysser av mot
 * partisjonene HAPI faktisk har. Avvik mellom de to registrene er en driftsfeil
 * som må synes, ikke skjules.
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

export const actions: Actions = {
	create: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const text = (n: string) => String(form.get(n) ?? '').trim();

		const result = await createTenant(
			{
				id: text('id').toLowerCase(),
				name: text('navn'),
				organisation_number: text('organisasjonsnummer').replace(/\s/g, ''),
				herId: text('herId') || undefined,
				municipality_code: text('kommunenummer') || undefined,
				hostname: text('vertsnavn').toLowerCase() || undefined,
				baseUrl: text('baseUrl').replace(/\/$/, ''),
				note: text('merknad') || undefined,
				adminUsername: text('adminBrukernavn') || undefined,
				adminName: text('adminNavn') || undefined
			},
			actorFromContext(ctx)
		);

		if (!result.ok) return fail(400, { error: result.error });
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
