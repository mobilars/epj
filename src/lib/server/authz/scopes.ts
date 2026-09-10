/**
 * SMART on FHIR scopes, versjon 2 (`patient/Observation.rs`) med bakoverkompatibel
 * tolkning av versjon 1 (`patient/Observation.read`).
 *
 * Helsedirektoratets anbefaling HITR 1225 om bruk av SMART on FHIR legger til
 * grunn SMART App Launch. Scope er *ytre* ramme for hva en app kan be om;
 * den endelige avgjørelsen tas i `tilgang.ts`, som i tillegg krever tjenstlig
 * behov og tar hensyn til sperringer. En app kan aldri få mer enn brukeren har.
 */

export type Operation = 'c' | 'r' | 'u' | 'd' | 's';
export type Context = 'patient' | 'user' | 'system';

export interface ParsedScope {
	context: Context;
	/** `*` betyr alle ressurstyper. */
	resource: string;
	operations: Set<Operation>;
	/** Valgfri søkebegrensning, f.eks. `category=vital-signs`. */
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
		// Rekkefølgen c-r-u-d-s er normativ i SMART v2.
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
	/** Settes for kall som gjelder én bestemt pasient. */
	contextPatientId?: string | null;
	/** Pasienten som er i launch-kontekst for tokenet. */
	tokenPatientId?: string | null;
}

export interface ScopeResponse {
	allowed: boolean;
	reason?: string;
	/** Søkebegrensninger som må tvinges inn i spørringen. */
	limitations: URLSearchParams[];
	/** True når tilgangen kun er innvilget for launch-pasienten. */
	onlyLaunchPatient: boolean;
}

/** Avgjør om scope-settet dekker en operasjon. */
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

	// Er alle treffende scopes begrenset, må begrensningene håndheves. Finnes det
	// minst ett ubegrenset scope, gjelder ingen begrensning.
	const allBegrenset = relevante.every((s) => s.limitation !== undefined);
	const limitations = allBegrenset
		? relevante.map((s) => s.limitation as URLSearchParams)
		: [];

	return { allowed: true, limitations, onlyLaunchPatient: !hasBredere };
}

/**
 * Snevrer inn et forespurt scope-sett til det brukeren faktisk har lov til.
 * Brukes på autorisasjonsendepunktet: en app kan ikke få tilgang brukeren mangler.
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
 * Avgjør om et scope dekkes av et sett andre scope.
 *
 * `*` dekker alle ressurstyper, og et scope med flere operasjoner dekker et med
 * færre. `patient/` dekkes også av tilsvarende `user/`, fordi patient-varianten
 * er en innsnevring til én pasient: har rollen lov til å lese målinger for alle
 * pasientene sine, har den også lov til å la en app lese målinger for én av dem.
 * Motsatt vei gjelder ikke, og `system/` dekker ingenting av dette - det er
 * forbeholdt tjeneste-til-tjeneste-tilgang uten bruker.
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

/** Menneskelig forklaring til samtykkedialogen. */
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
