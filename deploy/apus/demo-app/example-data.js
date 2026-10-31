// @ts-nocheck: a plain script served to the browser as it stands.
/**
 * Example data, for showing an app on a patient with nothing to show.
 *
 * These are invented entries written into a patient's real record, so three things
 * keep them from being taken for real ones. The button only appears against a test
 * environment. Every value carries a tag and a note saying what it is, which the record
 * also shows. And it can be taken out again, the way the record takes anything out: by
 * marking it entered in error, not by deleting it.
 */

export const EXAMPLE_TAG = { system: 'https://epj.apps.apus.no/fhir/demo', code: 'eksempeldata' };

const WRITE_SCOPE = 'patient/Observation.cu';

/** Local development and the demo environment. Any other record is treated as real. */
export function isTestRecord(iss) {
	try {
		const { hostname } = new URL(iss);
		return hostname === 'localhost' || hostname === '127.0.0.1' || /^[a-z0-9-]+\.apps\.apus\.no$/.test(hostname);
	} catch {
		return false;
	}
}

export const isExample = (o) => (o.meta?.tag ?? []).some((t) => t.system === EXAMPLE_TAG.system && t.code === EXAMPLE_TAG.code);

export const monthsAgo = (months) => {
	const date = new Date();
	date.setMonth(date.getMonth() - months);
	return date.toISOString();
};

/** One tagged measurement. `lab` for a laboratory result, otherwise a vital sign. */
export function exampleObservation(patientId, { code, display, value, unit, when, lab = false }) {
	return {
		resourceType: 'Observation',
		meta: { tag: [EXAMPLE_TAG] },
		status: 'final',
		category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: lab ? 'laboratory' : 'vital-signs' }] }],
		code: { coding: [{ system: 'http://loinc.org', code, display }], text: display },
		subject: { reference: `Patient/${patientId}` },
		effectiveDateTime: when,
		valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit },
		note: NOTE
	};
}

const NOTE = [{ text: 'Eksempeldata lagt inn fra en demonstrasjonsapp. Ikke reelle opplysninger.' }];

export function exampleCondition(patientId, { code, text, when }) {
	return {
		resourceType: 'Condition',
		meta: { tag: [EXAMPLE_TAG] },
		clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
		verificationStatus: { coding: [{ system: VERIFICATION_STATUS, code: 'confirmed' }] },
		category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
		code: { coding: [{ system: 'urn:oid:2.16.578.1.12.4.1.1.7170', code, display: text }], text },
		subject: { reference: `Patient/${patientId}` },
		recordedDate: when,
		note: NOTE
	};
}

export function exampleMedication(patientId, { name, dosage, when }) {
	return {
		resourceType: 'MedicationRequest',
		meta: { tag: [EXAMPLE_TAG] },
		status: 'active',
		intent: 'order',
		medication: { concept: { text: name } },
		subject: { reference: `Patient/${patientId}` },
		authoredOn: when,
		dosageInstruction: [{ text: dosage }],
		note: NOTE
	};
}

const VERIFICATION_STATUS = 'http://terminology.hl7.org/CodeSystem/condition-ver-status';

/** Whether an entry has been taken out. A condition says so in a field of its own. */
export const isRetired = (resource) =>
	resource.status === 'entered-in-error' || (resource.verificationStatus?.coding ?? []).some((c) => c.code === 'entered-in-error');

const retired = (resource) =>
	resource.resourceType === 'Condition'
		? { ...resource, verificationStatus: { coding: [{ system: VERIFICATION_STATUS, code: 'entered-in-error' }] } }
		: { ...resource, status: 'entered-in-error' };

/**
 * Draws the buttons into `target`, or nothing if this is not the place for them.
 *
 * `resources` is what the app has read, `examples` returns what to add, and `onChange`
 * redraws the app afterwards.
 */
export function mountExampleControls(target, { smart, resources, examples, onChange }) {
	if (!target || !isTestRecord(smart.iss) || !smart.scopes.includes(WRITE_SCOPE)) return;

	const existing = resources.filter((resource) => isExample(resource) && !isRetired(resource));
	const planned = examples();
	if (!existing.length && !planned.length) return;

	target.innerHTML = `
		<h2>Eksempeldata</h2>
		${
			existing.length
				? `<div class="varsel varsel-advarsel liten">${existing.length} av oppføringene her er oppdiktet eksempeldata, ikke reelle opplysninger.</div>
					<button type="button" id="fjern-eksempler">Fjern eksempeldata</button>`
				: `<p class="svak liten">Testmiljø. Legger inn ${planned.length} oppdiktede oppføringer på pasienten, så du kan se hvordan appen virker. De merkes tydelig og kan fjernes igjen.</p>
					<button type="button" id="legg-inn-eksempler">Legg inn eksempeldata</button>`
		}
		<div id="eksempel-feil"></div>`;

	const failed = (result) => {
		target.querySelector('#eksempel-feil').innerHTML = '<div class="varsel varsel-feil"></div>';
		target.querySelector('#eksempel-feil div').textContent = `Journalen avviste endringen (${result.status}).`;
	};

	target.querySelector('#legg-inn-eksempler')?.addEventListener('click', async () => {
		if (!confirm(`Legge inn ${planned.length} oppdiktede oppføringer i journalen til denne pasienten?`)) return;
		const results = await Promise.all(planned.map((resource) => smart.create(resource)));
		const rejected = results.find((r) => !r.ok);
		if (rejected) return failed(rejected);
		await onChange();
	});

	target.querySelector('#fjern-eksempler')?.addEventListener('click', async () => {
		const results = await Promise.all(existing.map((resource) => smart.update(retired(resource))));
		const rejected = results.find((r) => !r.ok);
		if (rejected) return failed(rejected);
		await onChange();
	});
}
