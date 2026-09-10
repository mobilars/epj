import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { patientRecord, resources } from '$srv/fhir/internal';
import { formatsDate, klinisksStatus, codeText, codeValue } from '$srv/fhir/display';
import type { FhirResource } from '$srv/fhir/types';

/** Klinisk oversiktsbilde: diagnoser, legemidler, allergier, siste målinger og notater. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { grupper: null };

	const bundle = await patientRecord(ctx, event.params.id, 400);
	const all = resources(bundle);
	const of = (type: string) => all.filter((r) => r.resourceType === type);

	const sorterOnDate = (a: FhirResource, b: FhirResource) =>
		String(b.meta?.loadUpdated ?? '').localeCompare(String(a.meta?.loadUpdated ?? ''));

	return {
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
