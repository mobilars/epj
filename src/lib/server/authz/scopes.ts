/**
 * SMART on FHIR scopes, versjon 2 (`patient/Observation.rs`) med bakoverkompatibel
 * tolkning av versjon 1 (`patient/Observation.read`).
 *
 * Helsedirektoratets anbefaling HITR 1225 om bruk av SMART on FHIR legger til
 * grunn SMART App Launch. Scope er *ytre* ramme for hva en app kan be om;
 * den endelige avgjørelsen tas i `tilgang.ts`, som i tillegg krever tjenstlig
 * behov og tar hensyn til sperringer. En app kan aldri få mer enn brukeren har.
 */

export type Operasjon = 'c' | 'r' | 'u' | 'd' | 's';
export type Kontekst = 'patient' | 'user' | 'system';

export interface ParsetScope {
	kontekst: Kontekst;
	/** `*` betyr alle ressurstyper. */
	ressurs: string;
	operasjoner: Set<Operasjon>;
	/** Valgfri søkebegrensning, f.eks. `category=vital-signs`. */
	begrensning?: URLSearchParams;
	rå: string;
}

const V1_KART: Record<string, Operasjon[]> = {
	read: ['r', 's'],
	write: ['c', 'u', 'd'],
	'*': ['c', 'r', 'u', 'd', 's']
};

const SCOPE_MONSTER = /^(patient|user|system)\/(\*|[A-Za-z]+)\.([a-z*]+)(\?.*)?$/;

export function parseScope(rå: string): ParsetScope | null {
	const m = SCOPE_MONSTER.exec(rå.trim());
	if (!m) return null;
	const [, kontekst, ressurs, opsDel, spørring] = m;

	let operasjoner: Operasjon[];
	if (opsDel in V1_KART) {
		operasjoner = V1_KART[opsDel];
	} else if (/^[cruds]+$/.test(opsDel)) {
		operasjoner = [...new Set(opsDel.split('') as Operasjon[])];
		// Rekkefølgen c-r-u-d-s er normativ i SMART v2.
		const forventet = ['c', 'r', 'u', 'd', 's'].filter((o) => operasjoner.includes(o as Operasjon)).join('');
		if (opsDel !== forventet) return null;
	} else {
		return null;
	}

	return {
		kontekst: kontekst as Kontekst,
		ressurs,
		operasjoner: new Set(operasjoner),
		begrensning: spørring ? new URLSearchParams(spørring.slice(1)) : undefined,
		rå: rå.trim()
	};
}

export const SPESIALSCOPES = new Set([
	'openid', 'profile', 'fhirUser', 'email',
	'launch', 'launch/patient', 'launch/encounter',
	'offline_access', 'online_access'
]);

export interface ScopeSett {
	kliniske: ParsetScope[];
	spesielle: Set<string>;
	rå: string[];
}

export function parseScopes(scopeStreng: string): ScopeSett {
	const deler = scopeStreng.split(/\s+/).filter(Boolean);
	const kliniske: ParsetScope[] = [];
	const spesielle = new Set<string>();
	for (const d of deler) {
		if (SPESIALSCOPES.has(d)) {
			spesielle.add(d);
			continue;
		}
		const parset = parseScope(d);
		if (parset) kliniske.push(parset);
	}
	return { kliniske, spesielle, rå: deler };
}

export interface ScopeSpørsmål {
	ressurs: string;
	operasjon: Operasjon;
	/** Settes for kall som gjelder én bestemt pasient. */
	kontekstPasientId?: string | null;
	/** Pasienten som er i launch-kontekst for tokenet. */
	tokenPasientId?: string | null;
}

export interface ScopeSvar {
	tillatt: boolean;
	grunn?: string;
	/** Søkebegrensninger som må tvinges inn i spørringen. */
	begrensninger: URLSearchParams[];
	/** True når tilgangen kun er innvilget for launch-pasienten. */
	kunLaunchPasient: boolean;
}

/** Avgjør om scope-settet dekker en operasjon. */
export function sjekkScope(sett: ScopeSett, spm: ScopeSpørsmål): ScopeSvar {
	const relevante = sett.kliniske.filter(
		(s) => (s.ressurs === '*' || s.ressurs === spm.ressurs) && s.operasjoner.has(spm.operasjon)
	);
	if (relevante.length === 0) {
		return {
			tillatt: false,
			grunn: `Tokenet mangler scope for ${spm.operasjon} på ${spm.ressurs}`,
			begrensninger: [],
			kunLaunchPasient: false
		};
	}

	const harBredere = relevante.some((s) => s.kontekst === 'user' || s.kontekst === 'system');
	const pasientScopes = relevante.filter((s) => s.kontekst === 'patient');

	if (!harBredere && pasientScopes.length > 0) {
		if (!spm.tokenPasientId) {
			return {
				tillatt: false,
				grunn: 'patient/-scope krever pasient i launch-kontekst',
				begrensninger: [],
				kunLaunchPasient: true
			};
		}
		if (spm.kontekstPasientId && spm.kontekstPasientId !== spm.tokenPasientId) {
			return {
				tillatt: false,
				grunn: 'Tokenet gjelder en annen pasient enn forespørselen',
				begrensninger: [],
				kunLaunchPasient: true
			};
		}
	}

	// Er alle treffende scopes begrenset, må begrensningene håndheves. Finnes det
	// minst ett ubegrenset scope, gjelder ingen begrensning.
	const alleBegrenset = relevante.every((s) => s.begrensning !== undefined);
	const begrensninger = alleBegrenset
		? relevante.map((s) => s.begrensning as URLSearchParams)
		: [];

	return { tillatt: true, begrensninger, kunLaunchPasient: !harBredere };
}

/**
 * Snevrer inn et forespurt scope-sett til det brukeren faktisk har lov til.
 * Brukes på autorisasjonsendepunktet: en app kan ikke få tilgang brukeren mangler.
 */
export function snevreInn(forespurt: string, tillatteForKlient: string[], tillatteForBruker: Set<string>): string {
	const klientTillatt = new Set(tillatteForKlient);
	return forespurt
		.split(/\s+/)
		.filter(Boolean)
		.filter((s) => klientTillatt.has(s) || dekkesAv(s, klientTillatt))
		.filter((s) => SPESIALSCOPES.has(s) || tillatteForBruker.has(s) || dekkesAv(s, tillatteForBruker))
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
export function dekkesAv(scope: string, tillatte: Set<string>): boolean {
	const parset = parseScope(scope);
	if (!parset) return false;
	for (const kandidat of tillatte) {
		const k = parseScope(kandidat);
		if (!k) continue;
		if (!kontekstDekker(k.kontekst, parset.kontekst)) continue;
		if (k.ressurs !== '*' && k.ressurs !== parset.ressurs) continue;
		if (k.begrensning && !parset.begrensning) continue;
		if ([...parset.operasjoner].every((o) => k.operasjoner.has(o))) return true;
	}
	return false;
}

function kontekstDekker(har: Kontekst, ber: Kontekst): boolean {
	if (har === ber) return true;
	return har === 'user' && ber === 'patient';
}

/** Menneskelig forklaring til samtykkedialogen. */
export function beskrivScope(scope: string): string {
	if (scope === 'openid' || scope === 'profile') return 'Vite hvem du er';
	if (scope === 'fhirUser') return 'Se hvilken behandler du er registrert som';
	if (scope === 'launch') return 'Følge pasient- og kontaktvalget ditt i journalen';
	if (scope === 'launch/patient') return 'Vite hvilken pasient som er åpen';
	if (scope === 'launch/encounter') return 'Vite hvilken konsultasjon som er åpen';
	if (scope === 'offline_access') return 'Fortsette å ha tilgang når du ikke er pålogget';
	if (scope === 'online_access') return 'Beholde tilgang så lenge du er pålogget';
	const p = parseScope(scope);
	if (!p) return scope;
	const omfang =
		p.kontekst === 'patient' ? 'for den åpne pasienten'
		: p.kontekst === 'user' ? 'for pasientene du har tilgang til'
		: 'for hele journalen (systemtilgang)';
	const ops: string[] = [];
	if (p.operasjoner.has('r') || p.operasjoner.has('s')) ops.push('lese');
	if (p.operasjoner.has('c')) ops.push('opprette');
	if (p.operasjoner.has('u')) ops.push('endre');
	if (p.operasjoner.has('d')) ops.push('slette');
	const hva = p.ressurs === '*' ? 'alle opplysninger' : RESSURS_NAVN[p.ressurs] ?? p.ressurs;
	return `${ops.join(', ')} ${hva} ${omfang}`;
}

const RESSURS_NAVN: Record<string, string> = {
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
