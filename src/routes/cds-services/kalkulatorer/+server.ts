import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fhirClient } from '$srv/fhir/client';
import { requireTenant } from '$srv/tenant/context';
import { HookCallerError, requireHookCaller } from '$srv/cds/signing';
import { ageYears, bmi, bmiClass, egfrCkdEpi2021, gfrCategory } from '$srv/cds/calculators';
import { SYSTEM } from '$srv/fhir/codesystems';
import type { FhirResource } from '$srv/fhir/types';
import { newId } from '$srv/util/ids';

/**
 * A service that does arithmetic the clinician would otherwise do in their
 * head, or not do.
 *
 * Answers `patient-view` with what can be computed from what is already in
 * the record: estimated GFR from the latest creatinine, age and sex, and BMI
 * from the latest height and weight. Each card says which measurements it
 * used and when they were taken, so the number can be trusted exactly as far
 * as its inputs.
 *
 * Kidney function is the one worth a warning. A creatinine that looks
 * unremarkable can hide an eGFR under 60 in an older patient, and that
 * changes what is safe to prescribe. The card turns yellow at G3a and offers
 * to file the finding as a Condition - a suggestion the clinician takes or
 * leaves, written as them if they take it.
 */

const LOINC = {
	creatinine: '2160-0',
	weight: '29463-7',
	height: '8302-2'
} as const;

const entries = (bundle: { entry?: { resource?: FhirResource }[] } | null): FhirResource[] =>
	(bundle?.entry ?? []).map((e) => e.resource as FhirResource).filter(Boolean);

function latest(observations: FhirResource[], loinc: string): { value: number; unit: string; when: string } | null {
	for (const o of observations) {
		const code = ((o.code as { coding?: { system?: string; code?: string }[] })?.coding ?? []).find((c) => c.code === loinc);
		if (!code) continue;
		const q = o.valueQuantity as { value?: number; unit?: string; code?: string } | undefined;
		if (typeof q?.value !== 'number') continue;
		return { value: q.value, unit: q.unit ?? q.code ?? '', when: (o.effectiveDateTime as string) ?? (o.issued as string) ?? '' };
	}
	return null;
}

const dato = (iso: string) => (iso ? new Date(iso).toLocaleDateString('nb-NO') : 'ukjent dato');

export const POST: RequestHandler = async (event) => {
	try {
		await requireHookCaller(event);
	} catch (err) {
		if (err instanceof HookCallerError) return json({ error: err.message }, { status: err.status });
		throw err;
	}

	const body = (await event.request.json().catch(() => ({}))) as { context?: { patientId?: string; patient?: string } };
	const patientId = body.context?.patientId ?? body.context?.patient;
	if (!patientId) return json({ cards: [] });

	const [patient, observations] = await Promise.all([
		fhirClient.read('Patient', patientId).catch(() => null),
		fhirClient
			.search('Observation', new URLSearchParams({ patient: patientId, _count: '200', _sort: '-date' }))
			.catch(() => null)
	]);
	if (!patient) return json({ cards: [] });

	const all = entries(observations);
	const tenant = requireTenant();
	const source = { label: `${tenant.name} · kalkulatorer` };
	const cards: unknown[] = [];

	// --- eGFR ------------------------------------------------------------
	const creatinine = latest(all, LOINC.creatinine);
	const age = typeof patient.birthDate === 'string' ? ageYears(patient.birthDate) : null;
	const sex = patient.gender === 'female' ? 'female' : patient.gender === 'male' ? 'male' : null;
	if (creatinine && age !== null && sex) {
		const egfr = egfrCkdEpi2021(creatinine.value, age, sex);
		const category = gfrCategory(egfr);
		const reduced = egfr < 60;
		cards.push({
			uuid: newId(),
			summary: `eGFR ${egfr} ml/min/1,73 m² (${category.code}, ${category.text})`,
			detail:
				`CKD-EPI 2021 fra kreatinin ${creatinine.value} ${creatinine.unit} målt ${dato(creatinine.when)}, ` +
				`alder ${age} år, ${sex === 'female' ? 'kvinne' : 'mann'}.` +
				(reduced ? ' Vurder dosejustering av legemidler som utskilles renalt, og forsiktighet med kontrastmidler og NSAID.' : ''),
			indicator: reduced ? 'warning' : 'info',
			source,
			...(reduced
				? {
						selectionBehavior: 'at-most-one',
						suggestions: [
							{
								label: `Registrer «nedsatt nyrefunksjon ${category.code}» som problem`,
								uuid: newId(),
								actions: [
									{
										type: 'create',
										description: 'Oppretter en Condition med ICPC-2 U99 og eGFR-kategorien i teksten.',
										resource: {
											resourceType: 'Condition',
											clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
											verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }] },
											category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
											code: {
												coding: [{ system: SYSTEM.ICPC2, code: 'U99', display: 'Urinveissykdom IKA' }],
												text: `Nedsatt nyrefunksjon, eGFR ${egfr} (${category.code}) ${dato(creatinine.when)}`
											},
											subject: { reference: `Patient/${patientId}` },
											recordedDate: new Date().toISOString()
										}
									}
								]
							}
						]
					}
				: {})
		});
	} else if (creatinine) {
		cards.push({
			uuid: newId(),
			summary: `Kreatinin ${creatinine.value} ${creatinine.unit} - eGFR kan ikke beregnes`,
			detail: 'Beregningen trenger fødselsdato og kjønn på pasienten.',
			indicator: 'info',
			source
		});
	}

	// --- BMI --------------------------------------------------------------
	const weight = latest(all, LOINC.weight);
	const height = latest(all, LOINC.height);
	if (weight && height && height.value > 0) {
		const value = bmi(weight.value, height.value);
		const klass = bmiClass(value);
		cards.push({
			uuid: newId(),
			summary: `BMI ${value.toLocaleString('nb-NO')} (${klass.text})`,
			detail: `Vekt ${weight.value} ${weight.unit} (${dato(weight.when)}), høyde ${height.value} ${height.unit} (${dato(height.when)}).`,
			indicator: klass.code === 'normal' || klass.code === 'overvekt' ? 'info' : 'warning',
			source
		});
	}

	return json({ cards });
};
