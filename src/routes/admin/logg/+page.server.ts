import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getLog, verifyLogChain } from '$srv/audit';

/** Sikkerhetsloggen for hele virksomheten, med integritetskontroll. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('admin:logg') && !ctx?.permissions.has('logg:innsyn')) error(403, 'Ingen tilgang.');

	const page = Math.max(0, Number(event.url.searchParams.get('side') ?? 0));
	const filter = {
		patientId: event.url.searchParams.get('patientId') ?? undefined,
		userId: event.url.searchParams.get('userId') ?? undefined,
		type: event.url.searchParams.get('type') ?? undefined,
		onlyEmergencyAccess: event.url.searchParams.get('nodrett') === '1',
		limit: 100,
		offset: page * 100
	};

	const [{ rows, total }, chain] = await Promise.all([getLog(filter), verifyLogChain()]);

	return {
		page,
		total,
		filter: {
			patientId: filter.patientId ?? '',
			userId: filter.userId ?? '',
			type: filter.type ?? '',
			onlyEmergencyAccess: filter.onlyEmergencyAccess
		},
		chain,
		rows: rows.map((r) => ({
			seq: r.seq,
			timestamp: new Date(r.recorded).toLocaleString('nb-NO'),
			hvem: r.actor_name ?? '',
			role: r.actor_role ?? '',
			type: r.type_code,
			subtype: r.subtype ?? '',
			action: r.action,
			outcome: r.outcome,
			patient: r.patient_id ?? '',
			resource: r.entity_ref ?? '',
			app: r.client_id ?? '',
			formal: r.purpose_of_use ?? '',
			ip: r.source_ip ?? '',
			requestId: r.request_id ?? ''
		}))
	};
};
