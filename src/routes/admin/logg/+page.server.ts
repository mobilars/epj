import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { hentLogg, verifiserLoggkjede } from '$srv/audit';

/** Sikkerhetsloggen for hele virksomheten, med integritetskontroll. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.rettigheter.has('admin:logg') && !ctx?.rettigheter.has('logg:innsyn')) error(403, 'Ingen tilgang.');

	const side = Math.max(0, Number(event.url.searchParams.get('side') ?? 0));
	const filter = {
		patientId: event.url.searchParams.get('patientId') ?? undefined,
		userId: event.url.searchParams.get('userId') ?? undefined,
		type: event.url.searchParams.get('type') ?? undefined,
		kunNodrett: event.url.searchParams.get('nodrett') === '1',
		limit: 100,
		offset: side * 100
	};

	const [{ rader, total }, kjede] = await Promise.all([hentLogg(filter), verifiserLoggkjede()]);

	return {
		side,
		total,
		filter: {
			patientId: filter.patientId ?? '',
			userId: filter.userId ?? '',
			type: filter.type ?? '',
			kunNodrett: filter.kunNodrett
		},
		kjede,
		rader: rader.map((r) => ({
			seq: r.seq,
			tidspunkt: new Date(r.recorded).toLocaleString('nb-NO'),
			hvem: r.actor_navn ?? '',
			rolle: r.actor_rolle ?? '',
			type: r.type_code,
			subtype: r.subtype ?? '',
			handling: r.action,
			utfall: r.outcome,
			pasient: r.patient_id ?? '',
			ressurs: r.entity_ref ?? '',
			app: r.client_id ?? '',
			formal: r.purpose_of_use ?? '',
			ip: r.source_ip ?? '',
			requestId: r.request_id ?? ''
		}))
	};
};
