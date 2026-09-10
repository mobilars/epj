import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { resources, writeResource, searchResources } from '$srv/fhir/internal';
import { formatsDate, codeText } from '$srv/fhir/display';
import { SYSTEM } from '$srv/fhir/codesystems';
import type { FhirResource } from '$srv/fhir/types';

/**
 * Journalnotater.
 *
 * Notatet lagres som FHIR Composition med seksjonene subjektivt, objektivt,
 * vurdering og plan. Notater endres ikke i etterkant: en retting lagres som ny
 * versjon, og HAPI beholder den forrige. Feilføringer merkes
 * `entered-in-error` framfor å slettes, slik pasientjournalforskriften krever.
 */

interface Section {
	title: string;
	text: string;
}

function seksjoner(c: FhirResource): Section[] {
	return ((c.section as { title?: string; text?: { div?: string } }[]) ?? []).map((s) => ({
		title: s.title ?? '',
		text: (s.text?.div ?? '').replace(/<[^>]+>/g, '').trim()
	}));
}

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { notes: [], canSkrive: false };

	const bundle = await searchResources(ctx, 'Composition', {
		patient: `Patient/${event.params.id}`,
		_count: 50,
		_sort: '-date'
	});

	return {
		canSkrive: ctx.permissions.has('journal:skriv'),
		notes: resources(bundle).map((c) => ({
			id: c.id as string,
			title: (c.title as string) ?? codeText(c.type),
			date: formatsDate(c.date as string, true),
			status: c.status as string,
			forfatter: ((c.author as { display?: string }[]) ?? [])[0]?.display ?? '',
			version: c.meta?.versionId ?? '1',
			seksjoner: seksjoner(c)
		}))
	};
};

const div = (text: string) => ({
	status: 'generated',
	div: `<div xmlns="http://www.w3.org/1999/xhtml">${text.replace(/[<>&]/g, (t) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[t] as string)}</div>`
});

export const actions: Actions = {
	newValue: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('journal:skriv')) return fail(403, { error: 'Rollen din kan ikke skrive i journal.' });

		const form = await event.request.formData();
		const title = String(form.get('tittel') ?? '').trim() || 'Konsultasjonsnotat';
		const subjektivt = String(form.get('subjektivt') ?? '').trim();
		const objektivt = String(form.get('objektivt') ?? '').trim();
		const assessment = String(form.get('vurdering') ?? '').trim();
		const diagnosisCode = String(form.get('diagnoseKode') ?? '').trim();
		const diagnosisText = String(form.get('diagnoseTekst') ?? '').trim();

		if (!subjektivt && !objektivt && !assessment) {
			return fail(400, { error: 'Notatet må ha innhold.' });
		}

		const patientId = event.params.id;
		const now = new Date().toISOString();

		// Kontakten (Encounter) knytter notat, diagnose og oppgjør sammen.
		const encounter = await writeResource(ctx, {
			resourceType: 'Encounter',
			status: 'completed',
			class: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Poliklinisk kontakt' }] }],
			subject: { reference: `Patient/${patientId}` },
			actualPeriod: { start: now, end: now },
			participant: [{ actor: { reference: ctx.actorRef, display: ctx.name } }]
		});

		if (diagnosisCode) {
			await writeResource(ctx, {
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
				verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] },
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }],
				code: { coding: [{ system: SYSTEM.ICPC2, code: diagnosisCode, display: diagnosisText || undefined }], text: diagnosisText || diagnosisCode },
				subject: { reference: `Patient/${patientId}` },
				encounter: { reference: `Encounter/${encounter.id}` },
				recordedDate: now
			});
		}

		await writeResource(ctx, {
			resourceType: 'Composition',
			status: 'final',
			type: { coding: [{ system: SYSTEM.LOINC, code: '11488-4', display: 'Konsultasjonsnotat' }] },
			subject: { reference: `Patient/${patientId}` },
			encounter: { reference: `Encounter/${encounter.id}` },
			date: now,
			author: [{ reference: ctx.actorRef, display: ctx.name }],
			title: title,
			section: [
				...(subjektivt ? [{ title: 'Subjektivt', text: div(subjektivt) }] : []),
				...(objektivt ? [{ title: 'Objektivt', text: div(objektivt) }] : []),
				...(assessment ? [{ title: 'Vurdering og plan', text: div(assessment) }] : [])
			]
		});

		redirect(303, `/pasienter/${patientId}/notater`);
	},

	feilfor: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('journal:rett')) return fail(403, { error: 'Rollen din kan ikke rette journalnotater.' });

		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const justification = String(form.get('begrunnelse') ?? '').trim();
		if (justification.length < 5) return fail(400, { error: 'Retting krever en begrunnelse.' });

		const bundle = await searchResources(ctx, 'Composition', { _id: id, _count: 1 });
		const note = resources(bundle)[0];
		if (!note) return fail(404, { error: 'Fant ikke notatet.' });

		// Notatet slettes ikke, men merkes som feilført, med begrunnelsen bevart.
		await writeResource(
			ctx,
			{
				...note,
				status: 'entered-in-error',
				note: [...((note.note as unknown[]) ?? []), { text: `Feilført: ${justification}`, time: new Date().toISOString() }]
			},
			id
		);
		redirect(303, `/pasienter/${event.params.id}/notater`);
	}
};
