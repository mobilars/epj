import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { aktorFraKontekst } from '$srv/audit';
import { forhandsvis, genererOppgjor, listOppgjor, sendOppgjor } from '$srv/integrasjoner/helfo/oppgjor';
import { listKort } from '$srv/integrasjoner/helfo/regningskort';
import { oreTilKroner } from '$srv/integrasjoner/helfo/takster';

/** Oppgjør mot Helfo: forhåndsvisning, generering og innsending. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.rettigheter.has('oppgjor:registrer') && !ctx.rettigheter.has('oppgjor:send')) redirect(303, '/');

	const idag = new Date();
	const forsteIManeden = new Date(Date.UTC(idag.getUTCFullYear(), idag.getUTCMonth(), 1)).toISOString().slice(0, 10);
	const fra = event.url.searchParams.get('fra') ?? forsteIManeden;
	const til = event.url.searchParams.get('til') ?? idag.toISOString().slice(0, 10);

	const [forhand, oppgjor, avviste] = await Promise.all([
		forhandsvis(fra, til),
		listOppgjor(20),
		listKort({ status: 'avvist', grense: 50 })
	]);

	return {
		fra,
		til,
		kanSende: ctx.rettigheter.has('oppgjor:send'),
		forhand: {
			antallKort: forhand.antallKort,
			sumRefusjon: oreTilKroner(forhand.sumRefusjonOre),
			sumEgenandel: oreTilKroner(forhand.sumEgenandelOre),
			advarsler: forhand.advarsler
		},
		avviste: avviste.map((k) => ({ id: k.id, dato: k.dato, patientId: k.patient_id, arsak: k.avvisning ?? '', refusjon: oreTilKroner(k.refusjon_ore) })),
		oppgjor: oppgjor.map((o) => ({
			id: o.id,
			periode: `${o.periode_fra} – ${o.periode_til}`,
			antall: o.antall_kort,
			sumRefusjon: oreTilKroner(o.sum_refusjon_ore),
			status: o.status,
			opprettet: new Date(o.opprettet).toLocaleString('nb-NO'),
			sendt: o.sendt ? new Date(o.sendt).toLocaleString('nb-NO') : null
		}))
	};
};

export const actions: Actions = {
	generer: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('oppgjor:send')) return fail(403, { feil: 'Rollen din kan ikke generere oppgjør.' });
		const form = await event.request.formData();
		const svar = await genererOppgjor(String(form.get('fra')), String(form.get('til')), aktorFraKontekst(ctx));
		if (!svar.ok) return fail(400, { feil: svar.feil });
		return { ok: true, melding: 'Oppgjøret er generert og klart for innsending.' };
	},

	send: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('oppgjor:send')) return fail(403, { feil: 'Rollen din kan ikke sende oppgjør.' });
		const form = await event.request.formData();
		const svar = await sendOppgjor(String(form.get('id')), aktorFraKontekst(ctx));
		if (!svar.ok) return fail(400, { feil: svar.feil });
		return { ok: true, melding: 'Oppgjøret er sendt til Helfo.' };
	}
};
