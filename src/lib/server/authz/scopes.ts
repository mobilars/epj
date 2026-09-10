/**
 * SMART on FHIR scopes, version 2 (`patient/Observation.rs`) with backward
 * compatible reading of version 1 (`patient/Observation.read`).
 *
 * The Directorate of Health's recommendation HITR 1225 on using SMART on FHIR
 * builds on SMART App Launch. Scope is the *outer* bound on what an app may ask
 * for; the final decision is made in `access.ts`, which additionally requires
 * legitimate need and honours restrictions. An app can never get more than the
 * user has.
 */
export type Operation = 'c' | 'r' | 'u' | 'd' | 's';
export type Context = 'patient' | 'user' | 'system';

export interface ParsedScope {
	context: Context;
	/** `*` means every resource type. */
	resource: string;
	operations: Set<Operation>;
	/** Optional search limitation, e.g. `category=vital-signs`. */
	limitation?: URLSearchParams;
	raw: string;
}

const V1_KART: Record<string, Operation[]> = {
	read: ['r', 's'],
	write: ['c', 'u', 'd'],
	'*': ['c', 'r', 'u', 'd', 's']
};

const SCOPE_MONSTER = /^(patient|user|system)\/(\*|[A-Za-z]+)\.([a-z*]+)(\?.*)?$/;

export function parseScope(raw: string): ParsedScope | null {
	const m = SCOPE_MONSTER.exec(raw.trim());
	if (!m) return null;
	const [, context, resource, opsDel, query] = m;

	let operations: Operation[];
	if (opsDel in V1_KART) {
		operations = V1_KART[opsDel];
	} else if (/^[cruds]+$/.test(opsDel)) {
		operations = [...new Set(opsDel.split('') as Operation[])];
		// The order c-r-u-d-s is normative in SMART v2.
		const expected = ['c', 'r', 'u', 'd', 's'].filter((o) => operations.includes(o as Operation)).join('');
		if (opsDel !== expected) return null;
	} else {
		return null;
	}

	return {
		context: context as Context,
		resource,
		operations: new Set(operations),
		limitation: query ? new URLSearchParams(query.slice(1)) : undefined,
		raw: raw.trim()
	};
}

export const SPESIALSCOPES = new Set([
	'openid', 'profile', 'fhirUser', 'email',
	'launch', 'launch/patient', 'launch/encounter',
	'offline_access', 'online_access'
]);

export interface ScopeSet {
	clinical: ParsedScope[];
	spesielle: Set<string>;
	raw: string[];
}

export function parseScopes(scopeString: string): ScopeSet {
	const parts = scopeString.split(/\s+/).filter(Boolean);
	const clinical: ParsedScope[] = [];
	const spesielle = new Set<string>();
	for (const d of parts) {
		if (SPESIALSCOPES.has(d)) {
			spesielle.add(d);
			continue;
		}
		const parsed = parseScope(d);
		if (parsed) clinical.push(parsed);
	}
	return { clinical, spesielle, raw: parts };
}

export interface ScopeQuestion {
	resource: string;
	operation: Operation;
	/** Set for calls concerning one particular patient. */
	contextPatientId?: string | null;
	/** The patient in launch context for the token. */
	tokenPatientId?: string | null;
}

export interface ScopeResponse {
	allowed: boolean;
	reason?: string;
	/** Search limitations that must be forced into the query. */
	limitations: URLSearchParams[];
	/** True when access is granted only for the launch patient. */
	onlyLaunchPatient: boolean;
}

/** Decides whether the scope set covers an operation. */
export function checkScope(set: ScopeSet, question: ScopeQuestion): ScopeResponse {
	const relevante = set.clinical.filter(
		(s) => (s.resource === '*' || s.resource === question.resource) && s.operations.has(question.operation)
	);
	if (relevante.length === 0) {
		return {
			allowed: false,
			reason: `Tokenet mangler scope for ${question.operation} på ${question.resource}`,
			limitations: [],
			onlyLaunchPatient: false
		};
	}

	const hasBredere = relevante.some((s) => s.context === 'user' || s.context === 'system');
	const patientScopes = relevante.filter((s) => s.context === 'patient');

	if (!hasBredere && patientScopes.length > 0) {
		if (!question.tokenPatientId) {
			return {
				allowed: false,
				reason: 'patient/-scope krever pasient i launch-kontekst',
				limitations: [],
				onlyLaunchPatient: true
			};
		}
		if (question.contextPatientId && question.contextPatientId !== question.tokenPatientId) {
			return {
				allowed: false,
				reason: 'Tokenet gjelder en annen pasient enn forespørselen',
				limitations: [],
				onlyLaunchPatient: true
			};
		}
	}

	// If every matching scope is limited, the limitations must be enforced. If at
	// least one is unlimited, no limitation applies.
	const allBegrenset = relevante.every((s) => s.limitation !== undefined);
	const limitations = allBegrenset
		? relevante.map((s) => s.limitation as URLSearchParams)
		: [];

	return { allowed: true, limitations, onlyLaunchPatient: !hasBredere };
}

/**
 * Narrows a requested scope set to what the user is actually allowed.
 * Used at the authorisation endpoint: an app cannot get access the user lacks.
 */
export function narrowIn(forespurt: string, allowedForClient: string[], allowedForUser: Set<string>): string {
	const clientAllowed = new Set(allowedForClient);
	return forespurt
		.split(/\s+/)
		.filter(Boolean)
		.filter((s) => clientAllowed.has(s) || coveredOf(s, clientAllowed))
		.filter((s) => SPESIALSCOPES.has(s) || allowedForUser.has(s) || coveredOf(s, allowedForUser))
		.join(' ');
}

/**
 * Decides whether a scope is covered by a set of other scopes.
 *
 * `*` covers every resource type, and a scope with more operations covers one
 * with fewer. `patient/` is also covered by the matching `user/`, because the
 * patient variant is a narrowing to one patient: if the role may read
 * observations for all its patients, it may also let an app read observations
 * for one of them. The reverse does not hold, and `system/` covers none of
 * this - it is reserved for service-to-service access without a user.
 */
export function coveredOf(scope: string, allowed: Set<string>): boolean {
	const parsed = parseScope(scope);
	if (!parsed) return false;
	for (const candidate of allowed) {
		const k = parseScope(candidate);
		if (!k) continue;
		if (!contextDekker(k.context, parsed.context)) continue;
		if (k.resource !== '*' && k.resource !== parsed.resource) continue;
		if (k.limitation && !parsed.limitation) continue;
		if ([...parsed.operations].every((o) => k.operations.has(o))) return true;
	}
	return false;
}

function contextDekker(has: Context, ber: Context): boolean {
	if (has === ber) return true;
	return has === 'user' && ber === 'patient';
}

/** Human-readable explanation for the consent dialog. */
export function describeScope(scope: string): string {
	if (scope === 'openid' || scope === 'profile') return 'Vite hvem du er';
	if (scope === 'fhirUser') return 'Se hvilken behandler du er registrert som';
	if (scope === 'launch') return 'Følge pasient- og kontaktvalget ditt i journalen';
	if (scope === 'launch/patient') return 'Vite hvilken pasient som er åpen';
	if (scope === 'launch/encounter') return 'Vite hvilken konsultasjon som er åpen';
	if (scope === 'offline_access') return 'Fortsette å ha tilgang når du ikke er pålogget';
	if (scope === 'online_access') return 'Beholde tilgang så lenge du er pålogget';
	const p = parseScope(scope);
	if (!p) return scope;
	const extent =
		p.context === 'patient' ? 'for den åpne pasienten'
		: p.context === 'user' ? 'for pasientene du har tilgang til'
		: 'for hele journalen (systemtilgang)';
	const ops: string[] = [];
	if (p.operations.has('r') || p.operations.has('s')) ops.push('lese');
	if (p.operations.has('c')) ops.push('opprette');
	if (p.operations.has('u')) ops.push('endre');
	if (p.operations.has('d')) ops.push('slette');
	const what = p.resource === '*' ? 'alle opplysninger' : RESOURCE_NAME[p.resource] ?? p.resource;
	return `${ops.join(', ')} ${what} ${extent}`;
}

const RESOURCE_NAME: Record<string, string> = {
	Patient: 'persondata',
	Observation: 'målinger og prøvesvar',
	Condition: 'diagnoser',
	MedicationRequest: 'resepter',
	MedicationStatement: 'legemidler i bruk',
	AllergyIntolerance: 'allergier',
	Immunization: 'vaksiner',
	Encounter: 'konsultasjoner',
	DocumentReference: 'dokumenter',
	Composition: 'journalnotater',
	DiagnosticReport: 'prøvesvar',
	Procedure: 'prosedyrer',
	ServiceRequest: 'henvisninger og rekvisisjoner',
	CarePlan: 'behandlingsplaner',
	Appointment: 'timeavtaler',
	Practitioner: 'opplysninger om behandlere',
	Consent: 'samtykker og sperringer',
	Coverage: 'trygdedekning',
	Claim: 'refusjonskrav'
};
