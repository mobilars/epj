import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { resources, writeResource, searchResources } from '$srv/fhir/internal';
import { formatsDate, codeText } from '$srv/fhir/display';
import { SYSTEM } from '$srv/fhir/codesystems';
import { isIcpc2Code, lookupIcpc2 } from '$srv/terminology/icpc2';
import type { FhirResource } from '$srv/fhir/types';
import { SEARCH_LIMIT, allNotes, highlight, matchesAll, searchTerms } from '$srv/journal/notesearch';
import { deleteTemplate, getTemplate, listTemplates, saveTemplate, templateProblem } from '$srv/journal/templates';

/**
 * Record notes.
 *
 * The note is stored as a FHIR Composition with the sections subjective,
 * objective, assessment and plan. Notes are not changed afterwards: a
 * correction is stored as a new version and HAPI keeps the previous one.
 * Mistakes are marked `entered-in-error` rather than deleted, as required.
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

/** How many notes the page shows when nobody is searching. */
const RECENT = 50;

/** What the clinician had typed, handed back so a refused save loses nothing. */
function draftFrom(form: FormData) {
	return {
		tittel: String(form.get('tittel') ?? ''),
		subjektivt: String(form.get('subjektivt') ?? ''),
		objektivt: String(form.get('objektivt') ?? ''),
		vurdering: String(form.get('vurdering') ?? ''),
		diagnoseKode: String(form.get('diagnoseKode') ?? ''),
		malnavn: String(form.get('malnavn') ?? '')
	};
}

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) {
		return { notes: [], canSkrive: false, search: null, recentOnly: false, templates: [], prefill: null };
	}

	const canSkrive = ctx.permissions.has('journal:skriv');
	const query = (event.url.searchParams.get('q') ?? '').trim();
	const terms = searchTerms(query);

	// A search reads every note there is; the ordinary view only the newest.
	// Both go through the gateway, so both are access-checked and logged.
	const [found, templates] = await Promise.all([
		terms.length
			? allNotes(ctx, event.params.id)
			: searchResources(ctx, 'Composition', { patient: `Patient/${event.params.id}`, _count: RECENT, _sort: '-date' }).then(
					(bundle) => ({ notes: resources(bundle), truncated: false })
				),
		canSkrive && ctx.userId ? listTemplates(ctx.userId) : Promise.resolve([])
	]);

	const notes = found.notes.map((c) => {
		const sections = seksjoner(c);
		const title = (c.title as string) ?? codeText(c.type);
		return {
			id: c.id as string,
			title,
			titleParts: highlight(title, terms),
			date: formatsDate(c.date as string, true),
			status: c.status as string,
			forfatter: ((c.author as { display?: string }[]) ?? [])[0]?.display ?? '',
			version: c.meta?.versionId ?? '1',
			seksjoner: sections.map((sec) => ({ ...sec, parts: highlight(sec.text, terms) }))
		};
	});

	const shown = terms.length
		? notes.filter((n) =>
				matchesAll([n.title, n.forfatter, ...n.seksjoner.flatMap((sec) => [sec.title, sec.text])].join('\n'), terms)
			)
		: notes;

	// A template picked without scripting arrives as ?mal=<id>. Looked up
	// against the owner, so an id from someone else's list fills nothing.
	const templateId = event.url.searchParams.get('mal');
	const chosen = templateId && ctx.userId && canSkrive ? await getTemplate(ctx.userId, templateId) : null;

	return {
		canSkrive,
		notes: shown,
		search: terms.length
			? { query, hits: shown.length, read: found.notes.length, truncated: found.truncated, limit: SEARCH_LIMIT }
			: null,
		// Only the newest were fetched, and there may be older ones.
		recentOnly: !terms.length && notes.length >= RECENT,
		templates: templates.map((t) => ({
			id: t.id,
			name: t.name,
			title: t.title,
			subjective: t.subjective,
			objective: t.objective,
			assessment: t.assessment
		})),
		prefill: chosen
			? { templateId: chosen.id, tittel: chosen.title, subjektivt: chosen.subjective, objektivt: chosen.objective, vurdering: chosen.assessment }
			: null
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
		const diagnosisCode = String(form.get('diagnoseKode') ?? '').trim().toUpperCase();

		if (!subjektivt && !objektivt && !assessment) {
			return fail(400, { error: 'Notatet må ha innhold.', draft: draftFrom(form) });
		}

		// The name comes from the Directorate's table, not from the form: a code
		// that is not in ICPC-2 is refused rather than filed under whatever was
		// typed beside it, and a code that is gets its official name.
		const diagnosis = diagnosisCode ? lookupIcpc2(diagnosisCode) : null;
		if (diagnosisCode && !isIcpc2Code(diagnosisCode)) {
			return fail(400, {
				error: diagnosis
					? `${diagnosisCode} er et kapittel eller en gruppe i ICPC-2, ikke en diagnosekode.`
					: `${diagnosisCode} finnes ikke i ICPC-2. Søk opp koden i feltet.`,
				draft: draftFrom(form)
			});
		}
		const diagnosisText = diagnosis?.display ?? '';

		const patientId = event.params.id;
		const now = new Date().toISOString();

		// The Encounter ties note, diagnosis and settlement together.
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

		// The note is not deleted, but marked as erroneous, with the reason kept.
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
	},

	/**
	 * Saves what is in the note form as one of the clinician's templates.
	 *
	 * Returns rather than redirects: the draft is handed back as it was, the
	 * diagnosis code included, so saving a template never costs the note.
	 */
	saveTemplate: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('journal:skriv')) return fail(403, { error: 'Rollen din kan ikke skrive i journal.' });

		const form = await event.request.formData();
		const draft = draftFrom(form);
		const content = {
			name: draft.malnavn.trim(),
			title: draft.tittel.trim(),
			subjective: draft.subjektivt.trim(),
			objective: draft.objektivt.trim(),
			assessment: draft.vurdering.trim()
		};
		const problem = templateProblem(content);
		if (problem) return fail(400, { error: problem, draft });

		await saveTemplate(ctx.userId, content);
		return { savedTemplate: content.name, draft };
	},

	deleteTemplate: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		await deleteTemplate(ctx.userId, String(form.get('id') ?? ''));
		redirect(303, `/pasienter/${event.params.id}/notater`);
	}
};
