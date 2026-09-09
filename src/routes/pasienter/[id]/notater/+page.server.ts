import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { ressurser, skrivRessurs, sokRessurser } from '$srv/fhir/internt';
import { formaterDato, kodeTekst } from '$srv/fhir/visning';
import { SYSTEM } from '$srv/fhir/kodeverk';
import type { FhirResource } from '$srv/fhir/types';

/**
 * Journalnotater.
 *
 * Notatet lagres som FHIR Composition med seksjonene subjektivt, objektivt,
 * vurdering og plan. Notater endres ikke i etterkant: en retting lagres som ny
 * versjon, og HAPI beholder den forrige. Feilføringer merkes
 * `entered-in-error` framfor å slettes, slik pasientjournalforskriften krever.
 */

interface Seksjon {
	tittel: string;
	tekst: string;
}

function seksjoner(c: FhirResource): Seksjon[] {
	return ((c.section as { title?: string; text?: { div?: string } }[]) ?? []).map((s) => ({
		tittel: s.title ?? '',
		tekst: (s.text?.div ?? '').replace(/<[^>]+>/g, '').trim()
	}));
}

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const forelder = await event.parent();
	if (!ctx || !forelder.pasient) return { notater: [], kanSkrive: false };

	const bundle = await sokRessurser(ctx, 'Composition', {
		patient: `Patient/${event.params.id}`,
		_count: 50,
		_sort: '-date'
	});

	return {
		kanSkrive: ctx.rettigheter.has('journal:skriv'),
		notater: ressurser(bundle).map((c) => ({
			id: c.id as string,
			tittel: (c.title as string) ?? kodeTekst(c.type),
			dato: formaterDato(c.date as string, true),
			status: c.status as string,
			forfatter: ((c.author as { display?: string }[]) ?? [])[0]?.display ?? '',
			versjon: c.meta?.versionId ?? '1',
			seksjoner: seksjoner(c)
		}))
	};
};

const div = (tekst: string) => ({
	status: 'generated',
	div: `<div xmlns="http://www.w3.org/1999/xhtml">${tekst.replace(/[<>&]/g, (t) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[t] as string)}</div>`
});

export const actions: Actions = {
	nytt: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('journal:skriv')) return fail(403, { feil: 'Rollen din kan ikke skrive i journal.' });

		const form = await event.request.formData();
		const tittel = String(form.get('tittel') ?? '').trim() || 'Konsultasjonsnotat';
		const subjektivt = String(form.get('subjektivt') ?? '').trim();
		const objektivt = String(form.get('objektivt') ?? '').trim();
		const vurdering = String(form.get('vurdering') ?? '').trim();
		const diagnoseKode = String(form.get('diagnoseKode') ?? '').trim();
		const diagnoseTekst = String(form.get('diagnoseTekst') ?? '').trim();

		if (!subjektivt && !objektivt && !vurdering) {
			return fail(400, { feil: 'Notatet må ha innhold.' });
		}

		const patientId = event.params.id;
		const na = new Date().toISOString();

		// Kontakten (Encounter) knytter notat, diagnose og oppgjør sammen.
		const encounter = await skrivRessurs(ctx, {
			resourceType: 'Encounter',
			status: 'completed',
			class: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Poliklinisk kontakt' }] }],
			subject: { reference: `Patient/${patientId}` },
			actualPeriod: { start: na, end: na },
			participant: [{ actor: { reference: ctx.actorRef, display: ctx.navn } }]
		});

		if (diagnoseKode) {
			await skrivRessurs(ctx, {
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
				verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] },
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }],
				code: { coding: [{ system: SYSTEM.ICPC2, code: diagnoseKode, display: diagnoseTekst || undefined }], text: diagnoseTekst || diagnoseKode },
				subject: { reference: `Patient/${patientId}` },
				encounter: { reference: `Encounter/${encounter.id}` },
				recordedDate: na
			});
		}

		await skrivRessurs(ctx, {
			resourceType: 'Composition',
			status: 'final',
			type: { coding: [{ system: SYSTEM.LOINC, code: '11488-4', display: 'Konsultasjonsnotat' }] },
			subject: { reference: `Patient/${patientId}` },
			encounter: { reference: `Encounter/${encounter.id}` },
			date: na,
			author: [{ reference: ctx.actorRef, display: ctx.navn }],
			title: tittel,
			section: [
				...(subjektivt ? [{ title: 'Subjektivt', text: div(subjektivt) }] : []),
				...(objektivt ? [{ title: 'Objektivt', text: div(objektivt) }] : []),
				...(vurdering ? [{ title: 'Vurdering og plan', text: div(vurdering) }] : [])
			]
		});

		redirect(303, `/pasienter/${patientId}/notater`);
	},

	feilfor: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.rettigheter.has('journal:rett')) return fail(403, { feil: 'Rollen din kan ikke rette journalnotater.' });

		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const begrunnelse = String(form.get('begrunnelse') ?? '').trim();
		if (begrunnelse.length < 5) return fail(400, { feil: 'Retting krever en begrunnelse.' });

		const bundle = await sokRessurser(ctx, 'Composition', { _id: id, _count: 1 });
		const notat = ressurser(bundle)[0];
		if (!notat) return fail(404, { feil: 'Fant ikke notatet.' });

		// Notatet slettes ikke, men merkes som feilført, med begrunnelsen bevart.
		await skrivRessurs(
			ctx,
			{
				...notat,
				status: 'entered-in-error',
				note: [...((notat.note as unknown[]) ?? []), { text: `Feilført: ${begrunnelse}`, time: new Date().toISOString() }]
			},
			id
		);
		redirect(303, `/pasienter/${event.params.id}/notater`);
	}
};
