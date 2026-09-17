import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { patientRecord, resources, writeResource } from '$srv/fhir/internal';
import { actorFromContext, log } from '$srv/audit';
import { formatsDate, klinisksStatus, codeText, codeValue } from '$srv/fhir/display';
import type { FhirResource } from '$srv/fhir/types';
import { acceptedActions, callHook, sendFeedback, type Card, type Suggestion } from '$srv/cds/hooks';

/** Clinical overview: diagnoses, medicines, allergies, latest measurements and notes. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { grupper: null, cds: { cards: [], failed: [] } };

	const bundle = await patientRecord(ctx, event.params.id, 400);
	const all = resources(bundle);
	const of = (type: string) => all.filter((r) => r.resourceType === type);

	const sorterOnDate = (a: FhirResource, b: FhirResource) =>
		String(b.meta?.loadUpdated ?? '').localeCompare(String(a.meta?.loadUpdated ?? ''));

	/**
	 * Advice from CDS Hooks services, at the moment the record is opened.
	 *
	 * Cards are advice: they cannot write, cannot block, and cannot change what
	 * is on screen. A service that is slow or down is skipped - a record that
	 * will not open is worse than one that opens without advice.
	 */
	const advice = await callHook('patient-view', ctx, {
		patientId: event.params.id,
		patient: event.params.id
	}).catch(() => ({ cards: [], failed: [] as string[] }));

	return {
		cds: advice,
		grupper: {
			diagnoses: of('Condition')
				.map((c) => ({
					id: c.id as string,
					text: codeText(c.code),
					code: codeValue(c.code).code ?? '',
					status: klinisksStatus(c),
					registered_at: formatsDate(c.recordedDate as string)
				}))
				.sort((a, b) => a.text.localeCompare(b.text, 'nb')),

			allergier: of('AllergyIntolerance').map((a) => ({
				id: a.id as string,
				text: codeText(a.code),
				kritikalitet: (a.criticality as string) ?? '',
				registered_at: formatsDate(a.recordedDate as string)
			})),

			medications: of('MedicationRequest')
				.filter((m) => m.status === 'active')
				.map((m) => ({
					id: m.id as string,
					name: codeText((m.medication as { concept?: unknown })?.concept),
					dosage: ((m.dosageInstruction as { text?: string }[]) ?? [])[0]?.text ?? '',
					forskrevet: formatsDate(m.authoredOn as string)
				})),

			malinger: of('Observation')
				.sort(sorterOnDate)
				.slice(0, 12)
				.map((o) => ({
					id: o.id as string,
					name: codeText(o.code),
					value: o.valueQuantity
						? `${(o.valueQuantity as { value: number }).value} ${(o.valueQuantity as { unit?: string }).unit ?? ''}`.trim()
						: codeText(o.valueCodeableConcept) || String(o.valueString ?? ''),
					timestamp: formatsDate((o.effectiveDateTime as string) ?? (o.issued as string), true)
				})),

			notes: of('Composition')
				.sort(sorterOnDate)
				.slice(0, 5)
				.map((c) => ({
					id: c.id as string,
					title: (c.title as string) ?? codeText(c.type),
					date: formatsDate(c.date as string, true),
					forfatter: ((c.author as { display?: string }[]) ?? [])[0]?.display ?? ''
				})),

			kontakter: of('Encounter')
				.sort(sorterOnDate)
				.slice(0, 8)
				.map((e) => ({
					id: e.id as string,
					type: codeText(((e.type as unknown[]) ?? [])[0]) || codeText(((e.class as unknown[]) ?? [])[0]),
					status: e.status as string,
					date: formatsDate((e.actualPeriod as { start?: string })?.start, true)
				})),

			vaksiner: of('Immunization').map((i) => ({
				id: i.id as string,
				name: codeText(i.vaccineCode),
				date: formatsDate(i.occurrenceDateTime as string)
			}))
		}
	};
};

/**
 * What a clinician does with a card.
 *
 * Accepting a suggestion is a write by the clinician - through the same door
 * as any other, judged by scope, role and relationship - and the service is
 * told it was taken. Setting a card aside tells the service that too. Neither
 * lets the service do anything; both let it learn.
 *
 * The card travels back in the form, because a card is a moment's advice
 * with no id in the record to look it up by. The write that follows is
 * judged on what the resource says, not on where the form said it came from,
 * so a tampered form can do no more than the clinician could do by hand.
 */
export const actions: Actions = {
	acceptSuggestion: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		let card: Card;
		let suggestion: Suggestion;
		try {
			card = JSON.parse(String(form.get('card') ?? '')) as Card;
			suggestion = JSON.parse(String(form.get('suggestion') ?? '')) as Suggestion;
		} catch {
			return fail(400, { cdsError: 'Forslaget kunne ikke leses.' });
		}

		const { resources: toCreate, refused } = acceptedActions(suggestion, event.params.id);
		if (!toCreate.length) {
			return fail(400, { cdsError: `Forslaget kan ikke utføres: ${refused.join('; ') || 'ingenting å opprette'}.` });
		}

		const created: string[] = [];
		for (const resource of toCreate) {
			const written = await writeResource(ctx, resource);
			created.push(`${written.resourceType}/${written.id}`);
		}
		await log(
			{
				type: 'cds', subtype: 'forslag:godtatt', action: 'C', outcome: '0',
				patientId: event.params.id, entityRef: created[0] ?? null,
				details: { service: card.serviceId ?? null, card: card.uuid ?? null, suggestion: suggestion.label, created: created.join(' ') }
			},
			actorFromContext(ctx)
		);
		await sendFeedback(card, 'accepted', { acceptedSuggestions: suggestion.uuid ? [{ id: suggestion.uuid }] : [] });
		return { cdsDone: `Utført: ${suggestion.label}${refused.length ? ` (hoppet over: ${refused.join('; ')})` : ''}` };
	},

	dismissCard: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		let card: Card;
		try {
			card = JSON.parse(String(form.get('card') ?? '')) as Card;
		} catch {
			return fail(400, { cdsError: 'Kortet kunne ikke leses.' });
		}
		const reason = String(form.get('reason') ?? '').trim();
		await log(
			{
				type: 'cds', subtype: 'kort:satt-til-side', action: 'E', outcome: '0',
				patientId: event.params.id, entityRef: `cds/${card.serviceId ?? 'ukjent'}`,
				details: { card: card.uuid ?? null, summary: card.summary, reason: reason || null }
			},
			actorFromContext(ctx)
		);
		await sendFeedback(card, 'overridden', reason ? { overrideReason: { code: reason } } : {});
		return { cdsDismissed: card.uuid ?? card.summary };
	}
};
