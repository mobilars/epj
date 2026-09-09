import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { aktorFraKontekst } from '$srv/audit';
import { lesRessursHvisFinnes } from '$srv/fhir/internt';
import { alderFra } from '$srv/fhir/visning';
import { listKort, opprettRegningskort, hentKort } from '$srv/integrasjoner/helfo/regningskort';
import { hentEgenandelstatus } from '$srv/integrasjoner/helfo/egenandel';
import { oreTilKroner, TAKSTER, TAKSTREGISTER_GYLDIG_FRA } from '$srv/integrasjoner/helfo/takster';

/** Regningskort for én pasient, med frikortstatus og takstvalg. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const forelder = await event.parent();
	if (!ctx || !forelder.pasient) return { kort: [], takster: [], egenandel: null, kanRegistrere: false, gyldigFra: TAKSTREGISTER_GYLDIG_FRA };

	const kort = await listKort({ patientId: event.params.id, grense: 50 });
	const egenandel = forelder.pasient.fodselsnummer
		? await hentEgenandelstatus(event.params.id, forelder.pasient.fodselsnummer, aktorFraKontekst(ctx)).catch(() => null)
		: null;

	return {
		kanRegistrere: ctx.rettigheter.has('oppgjor:registrer'),
		gyldigFra: TAKSTREGISTER_GYLDIG_FRA,
		takster: TAKSTER.map((t) => ({
			kode: t.kode, tekst: t.tekst, gruppe: t.gruppe,
			refusjon: oreTilKroner(t.refusjonOre), egenandel: oreTilKroner(t.egenandelOre),
			repeterbar: t.repeterbar ?? false
		})),
		egenandel: egenandel && {
			harFrikort: egenandel.harFrikort,
			gyldigTil: egenandel.frikortGyldigTil,
			opptjent: oreTilKroner(egenandel.opptjentOre),
			gjenstaende: oreTilKroner(egenandel.gjenstaendeOre),
			kilde: egenandel.kilde
		},
		kort: await Promise.all(
			kort.map(async (k) => {
				const detalj = await hentKort(k.id);
				return {
					id: k.id,
					dato: k.dato,
					status: k.status,
					kontakttype: k.kontakttype,
					diagnose: k.diagnose_kode ?? '',
					refusjon: oreTilKroner(k.refusjon_ore),
					egenandel: oreTilKroner(k.egenandel_ore),
					fritak: k.fritak_grunn ?? '',
					avvisning: k.avvisning ?? '',
					linjer: (detalj?.linjer ?? []).map((l) => `${l.takstkode}×${l.antall}`)
				};
			})
		)
	};
};

export const actions: Actions = {
	nytt: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('oppgjor:registrer')) return fail(403, { feil: 'Rollen din kan ikke registrere regningskort.' });

		const form = await event.request.formData();
		const takstkoder = form.getAll('takst').map(String).filter(Boolean);
		if (takstkoder.length === 0) return fail(400, { feil: 'Velg minst én takst.' });

		// Handlinger har ikke tilgang til forelderens data; pasienten hentes på nytt
		// gjennom vokteren, som samtidig kontrollerer at brukeren har tilgang.
		const pasient = await lesRessursHvisFinnes(ctx, 'Patient', event.params.id);
		const alder = pasient?.birthDate ? alderFra(pasient.birthDate as string) : undefined;

		const takster = takstkoder.map((kode) => ({
			takstkode: kode,
			antall: Number(form.get(`antall_${kode}`) ?? 1)
		}));

		const svar = await opprettRegningskort(
			{
				patientId: event.params.id,
				encounterId: String(form.get('encounterId') ?? '') || null,
				behandlerId: ctx.actorRef.replace('Practitioner/', ''),
				hprNummer: String(form.get('hpr') ?? '') || null,
				dato: String(form.get('dato') ?? new Date().toISOString().slice(0, 10)),
				kontakttype: String(form.get('kontakttype') ?? 'kontor') as 'kontor',
				diagnoseKode: String(form.get('diagnoseKode') ?? '').trim() || null,
				takster,
				erSpesialistAllmennmedisin: form.get('spesialist') === 'på',
				pasientAlder: alder
			},
			aktorFraKontekst(ctx)
		);

		if (!svar.ok) return fail(400, { feil: svar.feil?.join(' · ') });
		return { ok: true, advarsler: svar.advarsler ?? [] };
	}
};
