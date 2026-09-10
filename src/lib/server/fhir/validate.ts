import { FhirError, issue } from './outcome';
import { SEARCH_PARAMS } from './searchparams';
import type { FhirResource, OperationOutcomeIssue } from './types';
import { SYSTEM, validHprNumber, validNorwegianNationalId, validOrganisationNumber } from './codesystems';
import { getValues } from './fhirpath';

const ID_MONSTER = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * Strukturell validering pluss norske profilregler. Dette er ikke en fullstendig
 * StructureDefinition-validator: den dekker invariantene journalen selv er avhengig
 * av, samt identifikatorreglene fra HL7 Norway sine basisprofiler.
 */
export function validate(resource: unknown, expectedType?: string): OperationOutcomeIssue[] {
	const findings: OperationOutcomeIssue[] = [];
	if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) {
		return [issue('fatal', 'structure', 'Innholdet er ikke et JSON-objekt')];
	}
	const r = resource as FhirResource;
	if (typeof r.resourceType !== 'string' || r.resourceType.length === 0) {
		return [issue('fatal', 'structure', 'Mangler resourceType')];
	}
	if (expectedType && r.resourceType !== expectedType) {
		findings.push(issue('error', 'invariant', `Forventet ${expectedType}, fikk ${r.resourceType}`, ['resourceType']));
	}
	if (!SEARCH_PARAMS[r.resourceType]) {
		findings.push(issue('error', 'not-supported', `Ressurstypen ${r.resourceType} er ikke støttet av denne journalen`, ['resourceType']));
	}
	if (r.id !== undefined && (typeof r.id !== 'string' || !ID_MONSTER.test(r.id))) {
		findings.push(issue('error', 'value', 'Ugyldig logisk id (tillatt: A-Z a-z 0-9 - . inntil 64 tegn)', ['id']));
	}

	findings.push(...validateIdentifikatorer(r));
	findings.push(...validateObligatoriske(r));
	findings.push(...validateReferences(r));
	return findings;
}

function validateIdentifikatorer(r: FhirResource): OperationOutcomeIssue[] {
	const findings: OperationOutcomeIssue[] = [];
	const identifikatorer = getValues(r, 'identifier') as { system?: string; value?: string }[];
	identifikatorer.forEach((identifier, i) => {
		if (!identifier || typeof identifier !== 'object') return;
		const path = `${r.resourceType}.identifier[${i}].value`;
		if (!identifier.value) {
			findings.push(issue('error', 'required', 'Identifier.value mangler', [path]));
			return;
		}
		switch (identifier.system) {
			case SYSTEM.FNR:
			case SYSTEM.DNR:
			case SYSTEM.HNR:
				if (!validNorwegianNationalId(identifier.value)) {
					findings.push(issue('error', 'value', 'Ugyldig fødselsnummer/D-nummer (mod11-kontroll feilet)', [path]));
				}
				break;
			case SYSTEM.HPR:
				if (!validHprNumber(identifier.value)) {
					findings.push(issue('error', 'value', 'Ugyldig HPR-nummer', [path]));
				}
				break;
			case SYSTEM.ORGNR:
				if (!validOrganisationNumber(identifier.value)) {
					findings.push(issue('error', 'value', 'Ugyldig organisasjonsnummer (mod11-kontroll feilet)', [path]));
				}
				break;
		}
	});
	return findings;
}

/** Minimumskrav per ressurstype slik journalen bruker dem. */
const REQUIRED: Record<string, string[]> = {
	Patient: [],
	Encounter: ['status', 'subject'],
	Condition: ['subject'],
	Observation: ['status', 'code', 'subject'],
	MedicationRequest: ['status', 'intent', 'subject'],
	AllergyIntolerance: ['patient'],
	Immunization: ['status', 'vaccineCode', 'patient'],
	Procedure: ['status', 'subject'],
	DocumentReference: ['status', 'content'],
	Composition: ['status', 'type', 'author'],
	ServiceRequest: ['status', 'intent', 'subject'],
	DiagnosticReport: ['status', 'code'],
	Consent: ['status'],
	Communication: ['status'],
	Task: ['status', 'intent'],
	Claim: ['status', 'type', 'use', 'patient', 'provider'],
	Appointment: ['status']
};

const KODEDE_STATUSER: Record<string, string[]> = {
	'Encounter.status': ['planned', 'in-progress', 'on-hold', 'discharged', 'completed', 'cancelled', 'discontinued', 'entered-in-error', 'unknown'],
	'Observation.status': ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
	'MedicationRequest.status': ['active', 'on-hold', 'ended', 'stopped', 'completed', 'cancelled', 'entered-in-error', 'draft', 'unknown'],
	'MedicationRequest.intent': ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'],
	'Consent.status': ['draft', 'active', 'inactive', 'not-done', 'entered-in-error', 'unknown']
};

function validateObligatoriske(r: FhirResource): OperationOutcomeIssue[] {
	const findings: OperationOutcomeIssue[] = [];
	for (const field of REQUIRED[r.resourceType] ?? []) {
		const v = r[field];
		if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
			findings.push(issue('error', 'required', `${r.resourceType}.${field} er påkrevd`, [`${r.resourceType}.${field}`]));
		}
	}
	for (const [path, allowed] of Object.entries(KODEDE_STATUSER)) {
		const [type, field] = path.split('.');
		if (r.resourceType !== type) continue;
		const v = r[field];
		if (typeof v === 'string' && !allowed.includes(v)) {
			findings.push(issue('error', 'code-invalid', `Ugyldig verdi «${v}» for ${path}`, [path]));
		}
	}
	return findings;
}

const REFERENCE_MONSTER = /^(https?:\/\/\S+|urn:uuid:[0-9a-fA-F-]{36}|urn:oid:[\d.]+|#[\w-]+|[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[\w.-]+)?)$/;

function validateReferences(r: FhirResource, path = r.resourceType, dybde = 0): OperationOutcomeIssue[] {
	if (dybde > 12) return [];
	const findings: OperationOutcomeIssue[] = [];
	const go = (v: unknown, s: string) => {
		if (Array.isArray(v)) {
			v.forEach((x, i) => go(x, `${s}[${i}]`));
			return;
		}
		if (typeof v !== 'object' || v === null) return;
		const o = v as Record<string, unknown>;
		if (typeof o.reference === 'string' && !REFERENCE_MONSTER.test(o.reference)) {
			findings.push(issue('error', 'value', `Ugyldig referanse «${o.reference}»`, [`${s}.reference`]));
		}
		for (const [k, children] of Object.entries(o)) {
			if (k === 'reference') continue;
			go(children, `${s}.${k}`);
		}
	};
	for (const [k, v] of Object.entries(r)) {
		if (k === 'resourceType' || k === 'id') continue;
		go(v, `${path}.${k}`);
	}
	return findings;
}

/** Kaster hvis valideringen finner feil av alvorlighetsgrad error/fatal. */
export function validateOrKast(resource: unknown, expectedType?: string): FhirResource {
	const findings = validate(resource, expectedType);
	const error = findings.filter((f) => f.severity === 'error' || f.severity === 'fatal');
	if (error.length > 0) throw new FhirError(422, findings);
	return resource as FhirResource;
}
