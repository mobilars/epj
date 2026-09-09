import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { hentLogg, logg, aktorFraKontekst } from '$srv/audit';

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
	const forelder = await event.parent();
	if (!forelder.pasient) return { rader: [], total: 0, side: 0 };

	const side = Math.max(0, Number(event.url.searchParams.get('side') ?? 0));
	const { rader, total } = await hentLogg({ patientId: event.params.id, limit: 50, offset: side * 50 });

	await logg(
		{ type: 'rest', subtype: 'logg-innsyn', handling: 'R', utfall: '0', patientId: event.params.id, purposeOfUse: 'HOPERAT' },
		aktorFraKontekst(ctx)
	);

	return {
		side,
		total,
		rader: rader.map((r) => ({
			seq: r.seq,
			tidspunkt: new Date(r.recorded).toLocaleString('nb-NO'),
			hvem: r.actor_navn ?? 'ukjent',
			rolle: r.actor_rolle ?? '',
			hva: [r.type_code, r.subtype].filter(Boolean).join(' · '),
			ressurs: r.entity_ref ?? '',
			app: r.client_id ?? 'Journalen',
			utfall: r.outcome,
			nodrett: r.purpose_of_use === 'ETREAT',
			ip: r.source_ip ?? ''
		}))
	};
};
