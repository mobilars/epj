import type { FhirResource } from './types';

/**
 * Accepts R4-shaped resources on write and stores them as R5.
 *
 * Most Norwegian systems are on R4, and almost every SMART app in the wild is
 * written against it - the SMART App Launch examples, the client libraries and
 * the published Norwegian profiles all are. Refusing R4 on the way in means
 * every vendor has to keep a second code path just for us, which is a poor
 * trade when the differences are a handful of renamed fields.
 *
 * Only the shapes that actually moved between the versions are touched, and
 * only on the way in. What we store and serve is R5 throughout, so this is a
 * doorway rather than a second dialect running through the record.
 */

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * DocumentReference moved the most, and is what apps write when they file a
 * document: in R4 `context` is a backbone element holding the encounter, the
 * period and the setting; in R5 `context` is the encounter reference itself and
 * the rest sit on the resource.
 */
function documentReferenceFromR4(r: Obj): Obj {
	const out: Obj = { ...r };

	if (isObject(r.context)) {
		const context = r.context as Obj;
		const encounters = asArray(context.encounter).filter(isObject);
		if (encounters.length > 0) out.context = encounters;
		else delete out.context;

		if (context.period !== undefined && out.period === undefined) out.period = context.period;
		if (context.facilityType !== undefined && out.facilityType === undefined) out.facilityType = context.facilityType;
		if (context.practiceSetting !== undefined && out.practiceSetting === undefined) out.practiceSetting = context.practiceSetting;
		// R4 event is a CodeableConcept; R5 takes a CodeableReference.
		const events = asArray(context.event).filter(isObject);
		if (events.length > 0 && out.event === undefined) out.event = events.map((c) => ({ concept: c }));
		// `sourcePatientInfo` and `related` have no R5 counterpart on this
		// resource. Dropped rather than guessed at - the patient is on `subject`.
	}

	// R4 authenticator is a single party; R5 records who attested and how.
	if (r.authenticator !== undefined && out.attester === undefined) {
		out.attester = [
			{
				mode: {
					coding: [
						{ system: 'http://terminology.hl7.org/CodeSystem/composition-attestation-mode', code: 'official' }
					]
				},
				party: r.authenticator
			}
		];
		delete out.authenticator;
	}

	// R4 content.format is a Coding; R5 carries it as a profile on the content.
	if (Array.isArray(r.content)) {
		out.content = r.content.map((c) => {
			if (!isObject(c) || c.format === undefined) return c;
			const { format, ...rest } = c;
			return { ...rest, profile: [{ valueCoding: format }] };
		});
	}

	// R4 relatesTo.code is a code; R5 a CodeableConcept.
	if (Array.isArray(r.relatesTo)) {
		out.relatesTo = r.relatesTo.map((v) => {
			if (!isObject(v) || typeof v.code !== 'string') return v;
			return {
				...v,
				code: {
					coding: [{ system: 'http://hl7.org/fhir/document-relationship-type', code: v.code }]
				}
			};
		});
	}

	return out;
}

/**
 * R4 `Binary.securityContext` survives unchanged in R5, and the rest of the
 * type is identical, so an attachment needs nothing here. Kept as its own case
 * so the list below reads as what it is: the types we accept in both versions.
 */
const FROM_R4: Record<string, (r: Obj) => Obj> = {
	DocumentReference: documentReferenceFromR4
};

/** Returns the resource as R5. Untouched when it is already R5, or not a type that moved. */
export function normaliseFromR4(resource: FhirResource): FhirResource {
	const converter = FROM_R4[resource.resourceType];
	if (!converter) return resource;
	return converter(resource as unknown as Obj) as unknown as FhirResource;
}
