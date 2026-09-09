import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { aktorFraKontekst } from '$srv/audit';
import { forskriv, fornye, hentLegemiddelliste, seponer, synkHistorikk } from '$srv/integrasjoner/sfm';
import { config } from '$srv/config';

/**
 * Legemiddelliste og forskrivning gjennom Sentral forskrivningsmodul.
 *
 * Journalen viser listen fra SFM (Pasientens legemiddelliste) som kilden, og
 * markerer avvik som legen må ta stilling til. Forskrivning krever rettigheten
 * `resept:forskriv`.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const forelder = await event.parent();
	if (!ctx || !forelder.pasient) return { liste: null, historikk: [], kanForskrive: false, modus: config.integrasjoner.modus };

	const svar = await hentLegemiddelliste(event.params.id, aktorFraKontekst(ctx));
	return {
		liste: svar.ok ? svar.data : null,
		feil: svar.ok ? null : svar.feil,
		historikk: await synkHistorikk(event.params.id, 15),
		kanForskrive: ctx.rettigheter.has('resept:forskriv'),
		kanFornye: ctx.rettigheter.has('resept:fornye'),
		modus: config.integrasjoner.modus
	};
};

export const actions: Actions = {
	forskriv: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('resept:forskriv')) return fail(403, { feil: 'Rollen din kan ikke forskrive legemidler.' });

		const form = await event.request.formData();
		const navn = String(form.get('navn') ?? '').trim();
		const dosering = String(form.get('dosering') ?? '').trim();
		if (!navn || !dosering) return fail(400, { feil: 'Legemiddel og dosering må fylles ut.' });

		const svar = await forskriv(
			{
				patientId: event.params.id,
				forskriverHpr: String(form.get('hpr') ?? ''),
				forskriverNavn: ctx.navn,
				legemiddel: {
					navn,
					atc: String(form.get('atc') ?? '').trim() || undefined,
					styrke: String(form.get('styrke') ?? '').trim() || undefined,
					form: String(form.get('form') ?? '').trim() || undefined
				},
				dosering,
				mengde: String(form.get('mengde') ?? '1'),
				indikasjon: String(form.get('indikasjon') ?? '').trim() || undefined,
				refusjonKode: String(form.get('refusjonKode') ?? '').trim() || undefined,
				refusjonHjemmel: String(form.get('refusjonHjemmel') ?? '').trim() || undefined,
				reiterasjon: Number(form.get('reiterasjon') ?? 0)
			},
			aktorFraKontekst(ctx)
		);

		if (!svar.ok) return fail(502, { feil: svar.feil ?? 'Forskrivningen ble ikke gjennomført.' });
		const varsler = (svar.data as unknown as { varsler?: string[] })?.varsler ?? [];
		return { ok: true, reseptId: svar.reseptId, varsler };
	},

	seponer: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('resept:forskriv')) return fail(403, { feil: 'Rollen din kan ikke seponere legemidler.' });
		const form = await event.request.formData();
		const svar = await seponer(
			event.params.id,
			String(form.get('reseptId') ?? ''),
			String(form.get('arsak') ?? '').trim() || 'Ikke oppgitt',
			aktorFraKontekst(ctx)
		);
		if (!svar.ok) return fail(502, { feil: svar.feil });
		redirect(303, `/pasienter/${event.params.id}/legemidler`);
	},

	fornye: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('resept:fornye')) return fail(403, { feil: 'Rollen din kan ikke fornye resepter.' });
		const form = await event.request.formData();
		const svar = await fornye(event.params.id, String(form.get('reseptId') ?? ''), aktorFraKontekst(ctx));
		if (!svar.ok) return fail(502, { feil: svar.feil });
		redirect(303, `/pasienter/${event.params.id}/legemidler`);
	}
};
