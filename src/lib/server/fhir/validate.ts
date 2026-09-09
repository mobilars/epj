import { FhirError, issue } from './outcome';
import { SEARCH_PARAMS } from './searchparams';
import type { FhirResource, OperationOutcomeIssue } from './types';
import { SYSTEM, gyldigHprNummer, gyldigNorskPersonnummer, gyldigOrganisasjonsnummer } from './kodeverk';
import { hentVerdier } from './indexing';

const ID_MONSTER = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * Strukturell validering pluss norske profilregler. Dette er ikke en fullstendig
 * StructureDefinition-validator: den dekker invariantene journalen selv er avhengig
 * av, samt identifikatorreglene fra HL7 Norway sine basisprofiler.
 */
export function valider(ressurs: unknown, forventetType?: string): OperationOutcomeIssue[] {
	const funn: OperationOutcomeIssue[] = [];
	if (typeof ressurs !== 'object' || ressurs === null || Array.isArray(ressurs)) {
		return [issue('fatal', 'structure', 'Innholdet er ikke et JSON-objekt')];
	}
	const r = ressurs as FhirResource;
	if (typeof r.resourceType !== 'string' || r.resourceType.length === 0) {
		return [issue('fatal', 'structure', 'Mangler resourceType')];
	}
	if (forventetType && r.resourceType !== forventetType) {
		funn.push(issue('error', 'invariant', `Forventet ${forventetType}, fikk ${r.resourceType}`, ['resourceType']));
	}
	if (!SEARCH_PARAMS[r.resourceType]) {
		funn.push(issue('error', 'not-supported', `Ressurstypen ${r.resourceType} er ikke støttet av denne journalen`, ['resourceType']));
	}
	if (r.id !== undefined && (typeof r.id !== 'string' || !ID_MONSTER.test(r.id))) {
		funn.push(issue('error', 'value', 'Ugyldig logisk id (tillatt: A-Z a-z 0-9 - . inntil 64 tegn)', ['id']));
	}

	funn.push(...validerIdentifikatorer(r));
	funn.push(...validerObligatoriske(r));
	funn.push(...validerReferanser(r));
	return funn;
}

function validerIdentifikatorer(r: FhirResource): OperationOutcomeIssue[] {
	const funn: OperationOutcomeIssue[] = [];
	const identifikatorer = hentVerdier(r, 'identifier') as { system?: string; value?: string }[];
	identifikatorer.forEach((ident, i) => {
		if (!ident || typeof ident !== 'object') return;
		const sti = `${r.resourceType}.identifier[${i}].value`;
		if (!ident.value) {
			funn.push(issue('error', 'required', 'Identifier.value mangler', [sti]));
			return;
		}
		switch (ident.system) {
			case SYSTEM.FNR:
			case SYSTEM.DNR:
			case SYSTEM.HNR:
				if (!gyldigNorskPersonnummer(ident.value)) {
					funn.push(issue('error', 'value', 'Ugyldig fødselsnummer/D-nummer (mod11-kontroll feilet)', [sti]));
				}
				break;
			case SYSTEM.HPR:
				if (!gyldigHprNummer(ident.value)) {
					funn.push(issue('error', 'value', 'Ugyldig HPR-nummer', [sti]));
				}
				break;
			case SYSTEM.ORGNR:
				if (!gyldigOrganisasjonsnummer(ident.value)) {
					funn.push(issue('error', 'value', 'Ugyldig organisasjonsnummer (mod11-kontroll feilet)', [sti]));
				}
				break;
		}
	});
	return funn;
}

/** Minimumskrav per ressurstype slik journalen bruker dem. */
const OBLIGATORISK: Record<string, string[]> = {
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

function validerObligatoriske(r: FhirResource): OperationOutcomeIssue[] {
	const funn: OperationOutcomeIssue[] = [];
	for (const felt of OBLIGATORISK[r.resourceType] ?? []) {
		const v = r[felt];
		if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
			funn.push(issue('error', 'required', `${r.resourceType}.${felt} er påkrevd`, [`${r.resourceType}.${felt}`]));
		}
	}
	for (const [sti, tillatte] of Object.entries(KODEDE_STATUSER)) {
		const [type, felt] = sti.split('.');
		if (r.resourceType !== type) continue;
		const v = r[felt];
		if (typeof v === 'string' && !tillatte.includes(v)) {
			funn.push(issue('error', 'code-invalid', `Ugyldig verdi «${v}» for ${sti}`, [sti]));
		}
	}
	return funn;
}

const REFERANSE_MONSTER = /^(https?:\/\/\S+|urn:uuid:[0-9a-fA-F-]{36}|urn:oid:[\d.]+|#[\w-]+|[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[\w.-]+)?)$/;

function validerReferanser(r: FhirResource, sti = r.resourceType, dybde = 0): OperationOutcomeIssue[] {
	if (dybde > 12) return [];
	const funn: OperationOutcomeIssue[] = [];
	const gå = (v: unknown, s: string) => {
		if (Array.isArray(v)) {
			v.forEach((x, i) => gå(x, `${s}[${i}]`));
			return;
		}
		if (typeof v !== 'object' || v === null) return;
		const o = v as Record<string, unknown>;
		if (typeof o.reference === 'string' && !REFERANSE_MONSTER.test(o.reference)) {
			funn.push(issue('error', 'value', `Ugyldig referanse «${o.reference}»`, [`${s}.reference`]));
		}
		for (const [k, barn] of Object.entries(o)) {
			if (k === 'reference') continue;
			gå(barn, `${s}.${k}`);
		}
	};
	for (const [k, v] of Object.entries(r)) {
		if (k === 'resourceType' || k === 'id') continue;
		gå(v, `${sti}.${k}`);
	}
	return funn;
}

/** Kaster hvis valideringen finner feil av alvorlighetsgrad error/fatal. */
export function validerEllerKast(ressurs: unknown, forventetType?: string): FhirResource {
	const funn = valider(ressurs, forventetType);
	const feil = funn.filter((f) => f.severity === 'error' || f.severity === 'fatal');
	if (feil.length > 0) throw new FhirError(422, funn);
	return ressurs as FhirResource;
}
