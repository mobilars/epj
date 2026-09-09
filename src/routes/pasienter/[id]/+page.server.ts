import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { pasientJournal, ressurser } from '$srv/fhir/internt';
import { formaterDato, klinisksStatus, kodeTekst, kodeVerdi } from '$srv/fhir/visning';
import type { FhirResource } from '$srv/fhir/types';

/** Klinisk oversiktsbilde: diagnoser, legemidler, allergier, siste målinger og notater. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const forelder = await event.parent();
	if (!ctx || !forelder.pasient) return { grupper: null };

	const bundle = await pasientJournal(ctx, event.params.id, 400);
	const alle = ressurser(bundle);
	const av = (type: string) => alle.filter((r) => r.resourceType === type);

	const sorterPaDato = (a: FhirResource, b: FhirResource) =>
		String(b.meta?.lastUpdated ?? '').localeCompare(String(a.meta?.lastUpdated ?? ''));

	return {
		grupper: {
			diagnoser: av('Condition')
				.map((c) => ({
					id: c.id as string,
					tekst: kodeTekst(c.code),
					kode: kodeVerdi(c.code).kode ?? '',
					status: klinisksStatus(c),
					registrert: formaterDato(c.recordedDate as string)
				}))
				.sort((a, b) => a.tekst.localeCompare(b.tekst, 'nb')),

			allergier: av('AllergyIntolerance').map((a) => ({
				id: a.id as string,
				tekst: kodeTekst(a.code),
				kritikalitet: (a.criticality as string) ?? '',
				registrert: formaterDato(a.recordedDate as string)
			})),

			legemidler: av('MedicationRequest')
				.filter((m) => m.status === 'active')
				.map((m) => ({
					id: m.id as string,
					navn: kodeTekst((m.medication as { concept?: unknown })?.concept),
					dosering: ((m.dosageInstruction as { text?: string }[]) ?? [])[0]?.text ?? '',
					forskrevet: formaterDato(m.authoredOn as string)
				})),

			malinger: av('Observation')
				.sort(sorterPaDato)
				.slice(0, 12)
				.map((o) => ({
					id: o.id as string,
					navn: kodeTekst(o.code),
					verdi: o.valueQuantity
						? `${(o.valueQuantity as { value: number }).value} ${(o.valueQuantity as { unit?: string }).unit ?? ''}`.trim()
						: kodeTekst(o.valueCodeableConcept) || String(o.valueString ?? ''),
					tidspunkt: formaterDato((o.effectiveDateTime as string) ?? (o.issued as string), true)
				})),

			notater: av('Composition')
				.sort(sorterPaDato)
				.slice(0, 5)
				.map((c) => ({
					id: c.id as string,
					tittel: (c.title as string) ?? kodeTekst(c.type),
					dato: formaterDato(c.date as string, true),
					forfatter: ((c.author as { display?: string }[]) ?? [])[0]?.display ?? ''
				})),

			kontakter: av('Encounter')
				.sort(sorterPaDato)
				.slice(0, 8)
				.map((e) => ({
					id: e.id as string,
					type: kodeTekst(((e.type as unknown[]) ?? [])[0]) || kodeTekst(((e.class as unknown[]) ?? [])[0]),
					status: e.status as string,
					dato: formaterDato((e.actualPeriod as { start?: string })?.start, true)
				})),

			vaksiner: av('Immunization').map((i) => ({
				id: i.id as string,
				navn: kodeTekst(i.vaccineCode),
				dato: formaterDato(i.occurrenceDateTime as string)
			}))
		}
	};
};
