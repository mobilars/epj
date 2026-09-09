import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { aktorFraKontekst } from '$srv/audit';
import { listMeldinger, markerBehandlet, sendKo, ventendeKvitteringer } from '$srv/integrasjoner/nhn/meldingsko';

/** Meldingsinnboks for hele kontoret. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.rettigheter.has('melding:les')) redirect(303, '/');

	const filter = event.url.searchParams.get('filter') ?? 'inn';
	const utenKvittering = filter === 'uten-kvittering' ? await ventendeKvitteringer(60) : [];

	const meldinger =
		filter === 'uten-kvittering'
			? utenKvittering
			: await listMeldinger({ retning: filter === 'ut' ? 'ut' : 'inn', grense: 200 });

	return {
		filter,
		kanSende: ctx.rettigheter.has('melding:send'),
		meldinger: meldinger.map((m) => ({
			id: m.id,
			type: m.meldingstype,
			retning: m.retning,
			part: m.mottaker_navn ?? m.avsender_her ?? '',
			patientId: m.patient_id,
			status: m.status,
			apprec: m.apprec_status,
			detalj: m.status_detalj,
			forsok: m.forsok,
			opprettet: new Date(m.opprettet).toLocaleString('nb-NO')
		}))
	};
};

export const actions: Actions = {
	behandlet: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('melding:les')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		await markerBehandlet(String(form.get('id') ?? ''), aktorFraKontekst(ctx));
		redirect(303, '/meldinger');
	},

	sendKo: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('melding:send')) return fail(403, { feil: 'Ingen tilgang.' });
		const resultat = await sendKo();
		return { ok: true, ...resultat };
	}
};
