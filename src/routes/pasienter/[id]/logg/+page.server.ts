import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getLog, log, actorFromContext } from '$srv/audit';

/**
 * Innsynslogg.
 *
 * Pasienten har rett til å få vite hvem som har hatt tilgang til journalen
 * (pasientjournalloven § 18). Loggen vises her, og selve oppslaget i loggen
 * blir også loggført.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, '/logg-inn');
	const parent = await event.parent();
	if (!parent.patient) return { rows: [], total: 0, page: 0 };

	const page = Math.max(0, Number(event.url.searchParams.get('side') ?? 0));
	const { rows, total } = await getLog({ patientId: event.params.id, limit: 50, offset: page * 50 });

	await log(
		{ type: 'rest', subtype: 'logg-innsyn', action: 'R', outcome: '0', patientId: event.params.id, purposeOfUse: 'HOPERAT' },
		actorFromContext(ctx)
	);

	return {
		page,
		total,
		rows: rows.map((r) => ({
			seq: r.seq,
			timestamp: new Date(r.recorded).toLocaleString('nb-NO'),
			hvem: r.actor_name ?? 'ukjent',
			role: r.actor_role ?? '',
			hva: [r.type_code, r.subtype].filter(Boolean).join(' · '),
			resource: r.entity_ref ?? '',
			app: r.client_id ?? 'Journalen',
			outcome: r.outcome,
			emergencyAccess: r.purpose_of_use === 'ETREAT',
			ip: r.source_ip ?? ''
		}))
	};
};
