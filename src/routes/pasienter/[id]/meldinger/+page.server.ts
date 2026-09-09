import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { aktorFraKontekst } from '$srv/audit';
import { koeUt, listMeldinger, sendKo } from '$srv/integrasjoner/nhn/meldingsko';
import { byggDialogmelding, byggHenvisning } from '$srv/integrasjoner/nhn/meldinger';
import { hentMottaker, sokMottakere, tilPart } from '$srv/integrasjoner/nhn/adresseregister';
import { lesRessursHvisFinnes } from '$srv/fhir/internt';
import { tilPasientVisning } from '$srv/fhir/visning';
import { nyId } from '$srv/util/ids';
import { SYSTEM } from '$srv/fhir/kodeverk';

/** Meldinger knyttet til én pasient, og skjema for å sende dialogmelding eller henvisning. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const forelder = await event.parent();
	if (!ctx || !forelder.pasient) return { meldinger: [], mottakere: [], kanSende: false };

	return {
		kanSende: ctx.rettigheter.has('melding:send'),
		mottakere: (await sokMottakere('')).map((m) => ({ herId: m.herId, navn: m.navn, typer: m.stotterMeldinger })),
		meldinger: (await listMeldinger({ patientId: event.params.id, grense: 50 })).map((m) => ({
			id: m.id,
			retning: m.retning,
			type: m.meldingstype,
			part: m.mottaker_navn ?? m.avsender_her ?? '',
			status: m.status,
			apprec: m.apprec_status,
			detalj: m.status_detalj,
			opprettet: new Date(m.opprettet).toLocaleString('nb-NO')
		}))
	};
};

async function pasientPart(ctx: NonNullable<App.Locals['auth']>, patientId: string) {
	const pasient = await lesRessursHvisFinnes(ctx, 'Patient', patientId);
	if (!pasient) return null;
	const v = tilPasientVisning(pasient);
	const [fornavn, ...resten] = v.navn.split(' ');
	return {
		fnr: v.fodselsnummer ?? '',
		fornavn,
		etternavn: resten.join(' '),
		fodselsdato: v.fodselsdato ?? undefined,
		kjonn: v.kjonn === 'Kvinne' ? ('K' as const) : ('M' as const)
	};
}

export const actions: Actions = {
	dialog: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('melding:send')) return fail(403, { feil: 'Rollen din kan ikke sende meldinger.' });

		const form = await event.request.formData();
		const mottakerHer = String(form.get('mottaker') ?? '');
		const innhold = String(form.get('innhold') ?? '').trim();
		if (!mottakerHer || !innhold) return fail(400, { feil: 'Velg mottaker og skriv innhold.' });

		const mottaker = await hentMottaker(mottakerHer);
		const pasient = await pasientPart(ctx, event.params.id);
		if (!mottaker || !pasient) return fail(400, { feil: 'Fant ikke mottaker eller pasient.' });

		const msgId = nyId();
		const xml = byggDialogmelding({
			msgId,
			type: (String(form.get('type') ?? 'notat') as 'notat' | 'foresporsel'),
			innhold,
			mottaker: tilPart(mottaker),
			pasient,
			behandler: { navn: ctx.navn, hpr: String(form.get('hpr') ?? '') }
		});

		const resultat = await koeUt(
			{
				meldingstype: String(form.get('type') ?? 'notat') === 'foresporsel' ? 'DIALOG_FORESPORSEL' : 'DIALOG_NOTAT',
				msgId, patientId: event.params.id, mottakerHer, payloadXml: xml, opprettetAv: ctx.userId as string
			},
			aktorFraKontekst(ctx)
		);
		if (!resultat.ok) return fail(400, { feil: resultat.feil });
		await sendKo();
		redirect(303, `/pasienter/${event.params.id}/meldinger`);
	},

	henvisning: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('melding:send')) return fail(403, { feil: 'Rollen din kan ikke sende meldinger.' });

		const form = await event.request.formData();
		const mottakerHer = String(form.get('mottaker') ?? '');
		const problemstilling = String(form.get('problemstilling') ?? '').trim();
		if (!mottakerHer || !problemstilling) return fail(400, { feil: 'Velg mottaker og beskriv problemstillingen.' });

		const mottaker = await hentMottaker(mottakerHer);
		const pasient = await pasientPart(ctx, event.params.id);
		if (!mottaker || !pasient) return fail(400, { feil: 'Fant ikke mottaker eller pasient.' });

		const msgId = nyId();
		const diagnoseKode = String(form.get('diagnoseKode') ?? '').trim();
		const xml = byggHenvisning({
			msgId,
			mottaker: tilPart(mottaker),
			pasient,
			behandler: { navn: ctx.navn, hpr: String(form.get('hpr') ?? '') },
			diagnose: diagnoseKode ? { kode: diagnoseKode, tekst: String(form.get('diagnoseTekst') ?? ''), system: SYSTEM.ICPC2 } : undefined,
			problemstilling,
			anamnese: String(form.get('anamnese') ?? '').trim() || undefined,
			onsketUndersokelse: String(form.get('onsket') ?? '').trim() || undefined,
			hastegrad: (String(form.get('hastegrad') ?? 'ordinaer') as 'ordinaer' | 'haster' | 'akutt'),
			pasientenInformert: form.get('informert') === 'på'
		});

		const resultat = await koeUt(
			{ meldingstype: 'HENVIS', msgId, patientId: event.params.id, mottakerHer, payloadXml: xml, opprettetAv: ctx.userId as string },
			aktorFraKontekst(ctx)
		);
		if (!resultat.ok) return fail(400, { feil: resultat.feil });
		await sendKo();
		redirect(303, `/pasienter/${event.params.id}/meldinger`);
	}
};
