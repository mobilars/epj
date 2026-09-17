import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HookCallerError, requireHookCaller } from '$srv/cds/signing';
import { newId } from '$srv/util/ids';
import { fhirClient } from '$srv/fhir/client';
import type { FhirResource } from '$srv/fhir/types';

/**
 * A sample service: a word of warning before prescribing.
 *
 * Answers `medication-prescribe`, which fires while a prescription is being
 * written rather than when a record is opened. It checks the draft against
 * what the patient already takes and against their registered allergies.
 *
 * The list of interactions is three entries long and is a demonstration, not a
 * source. A real one comes from a maintained register - see docs/todo.md - and
 * the difference matters more here than anywhere else in the codebase: advice
 * that looks authoritative and is not is worse than no advice at all, because
 * silence from it will be read as "nothing to worry about".
 */

const INTERACTIONS: { a: string; b: string; text: string }[] = [
	{ a: 'warfarin', b: 'ibuprofen', text: 'Økt blødningsrisiko. Vurder paracetamol i stedet.' },
	{ a: 'metformin', b: 'kontrastmiddel', text: 'Pause metformin rundt undersøkelse med kontrast.' },
	{ a: 'simvastatin', b: 'erytromycin', text: 'Økt risiko for myopati. Vurder et annet antibiotikum.' }
];

interface Card {
	/** Names the card, so feedback about it can say which one. */
	uuid?: string;
	summary: string;
	detail?: string;
	indicator: 'info' | 'warning' | 'critical';
	source: { label: string };
}

const entries = (bundle: { entry?: { resource?: FhirResource }[] } | null): FhirResource[] =>
	(bundle?.entry ?? []).map((e) => e.resource as FhirResource).filter(Boolean);

function naming(resource: FhirResource): string {
	const medication = resource.medication as { concept?: { text?: string; coding?: { display?: string }[] } } | undefined;
	const legacy = resource.medicationCodeableConcept as { text?: string } | undefined;
	return (medication?.concept?.text ?? medication?.concept?.coding?.[0]?.display ?? legacy?.text ?? '').toLowerCase();
}

export const POST: RequestHandler = async (event) => {
	// Only the record itself may ask. Without this, anyone who found the URL
	// could post a patient id and be told what the record knows about them.
	try {
		await requireHookCaller(event);
	} catch (err) {
		if (err instanceof HookCallerError) return json({ error: err.message }, { status: err.status });
		throw err;
	}
	const body = (await event.request.json().catch(() => ({}))) as {
		context?: {
			patientId?: string;
			patient?: string;
			medications?: { entry?: { resource?: FhirResource }[] };
		};
	};
	const patientId = body.context?.patientId ?? body.context?.patient;
	if (!patientId) return json({ cards: [] });

	// What is being prescribed arrives with the hook; what the patient already
	// takes comes from the record.
	const draft = (body.context?.medications?.entry ?? []).map((e) => e.resource as FhirResource).filter(Boolean);
	const [current, allergies] = await Promise.all([
		fhirClient
			.search('MedicationRequest', new URLSearchParams({ patient: patientId, status: 'active', _count: '50' }))
			.catch(() => null),
		fhirClient
			.search('AllergyIntolerance', new URLSearchParams({ patient: patientId, _count: '30' }))
			.catch(() => null)
	]);

	const existing = entries(current).map(naming).filter(Boolean);
	const allergyNames = entries(allergies)
		.map((a) => ((a.code as { text?: string })?.text ?? '').toLowerCase())
		.filter(Boolean);

	const cards: Card[] = [];
	for (const item of draft.map(naming).filter(Boolean)) {
		for (const rule of INTERACTIONS) {
			const pair = [rule.a, rule.b];
			const inDraft = pair.find((m) => item.includes(m));
			const other = pair.find((m) => m !== inDraft);
			if (inDraft && other && existing.some((e) => e.includes(other))) {
				cards.push({
					uuid: newId(),
					summary: `Interaksjon: ${rule.a} og ${rule.b}`,
					detail: rule.text,
					indicator: 'warning',
					source: { label: 'Interaksjonssjekk (demo)' }
				});
			}
		}
		for (const allergy of allergyNames) {
			if (allergy && item.includes(allergy)) {
				cards.push({
					uuid: newId(),
					summary: `Pasienten er registrert allergisk mot ${allergy}`,
					indicator: 'critical',
					source: { label: 'Interaksjonssjekk (demo)' }
				});
			}
		}
	}

	return json({ cards }, { headers: { 'cache-control': 'no-store' } });
};
