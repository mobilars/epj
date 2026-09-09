import type { FhirResource, OperationOutcomeIssue, IssueSeverity } from './types';

export function operationOutcome(issues: OperationOutcomeIssue[]): FhirResource {
	return { resourceType: 'OperationOutcome', issue: issues };
}

export function issue(
	severity: IssueSeverity,
	code: string,
	diagnostics: string,
	expression?: string[]
): OperationOutcomeIssue {
	return { severity, code, diagnostics, ...(expression ? { expression } : {}) };
}

/** Feil som skal returneres til klienten med gitt HTTP-status og OperationOutcome. */
export class FhirError extends Error {
	constructor(
		readonly status: number,
		readonly issues: OperationOutcomeIssue[],
		/** Settes når feilen ikke skal avsløre om ressursen finnes (Normen: informasjonslekkasje). */
		readonly auditOutcome: '0' | '4' | '8' | '12' = status >= 500 ? '8' : '4'
	) {
		super(issues[0]?.diagnostics ?? 'FHIR-feil');
		this.name = 'FhirError';
	}

	toOutcome(): FhirResource {
		return operationOutcome(this.issues);
	}

	static ugyldig(melding: string, expression?: string[]): FhirError {
		return new FhirError(400, [issue('error', 'invalid', melding, expression)]);
	}
	static ikkeFunnet(melding = 'Ressursen finnes ikke'): FhirError {
		return new FhirError(404, [issue('error', 'not-found', melding)]);
	}
	static ikkeAutentisert(melding = 'Autentisering kreves'): FhirError {
		return new FhirError(401, [issue('error', 'login', melding)], '4');
	}
	static ikkeTillatt(melding = 'Ingen tilgang'): FhirError {
		return new FhirError(403, [issue('error', 'forbidden', melding)], '4');
	}
	static konflikt(melding: string): FhirError {
		return new FhirError(409, [issue('error', 'conflict', melding)]);
	}
	static forUtdatert(melding = 'Versjonskonflikt - ressursen er endret av andre'): FhirError {
		return new FhirError(412, [issue('error', 'conflict', melding)]);
	}
	static ikkeStottet(melding: string): FhirError {
		return new FhirError(422, [issue('error', 'not-supported', melding)]);
	}
	static forMange(melding = 'For mange forespørsler'): FhirError {
		return new FhirError(429, [issue('error', 'throttled', melding)], '4');
	}
	static internFeil(melding = 'Intern feil'): FhirError {
		return new FhirError(500, [issue('fatal', 'exception', melding)], '8');
	}
}
