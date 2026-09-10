/**
 * Rollemodell for et fastlegekontor.
 *
 * EPJ-standarden (Tilgangsstyring, retting og sletting) krever at tilgang gis ut
 * fra rolle og tjenstlig behov, ikke ut fra hvem som tilfeldigvis er pålogget.
 * Rollene her definerer *hva slags* opplysninger en stillingskategori kan se;
 * `tilgang.ts` avgjør deretter *hvilke pasienter* det gjelder.
 */

export const ROLLER = [
	'lege',
	'lege-vikar',
	'turnuslege',
	'sykepleier',
	'helsesekretaer',
	'bioingenior',
	'jordmor',
	'psykolog',
	'systemansvarlig',
	'personvernombud',
	'regnskap',
	'pasient',
	// Plattformnivå: tilhører ingen virksomhet, og har aldri klinisk tilgang.
	'systemeier'
] as const;

export type Rolle = (typeof ROLLER)[number];

export interface RolleDefinisjon {
	navn: string;
	beskrivelse: string;
	/** Scopes rollen maksimalt kan tildeles gjennom en SMART-app. */
	scopes: string[];
	/** Systemfunksjoner utenfor FHIR-API-et. */
	rettigheter: Rettighet[];
	/** Rollen kan bruke nødrettstilgang (break the glass). */
	kanNodrett: boolean;
	/** Rollen kan se journalinnhold uten registrert behandlingsrelasjon. */
	kanSeAllePasienter: boolean;
}

export const RETTIGHETER = [
	'journal:les',
	'journal:skriv',
	'journal:signer',
	'journal:rett',
	'journal:slett-begjaering',
	'resept:forskriv',
	'resept:fornye',
	'melding:les',
	'melding:send',
	'melding:signer',
	'oppgjor:registrer',
	'oppgjor:send',
	'time:administrer',
	'pasient:opprett',
	'pasient:sperr',
	'admin:brukere',
	'admin:apper',
	'admin:logg',
	'admin:system',
	'logg:innsyn',
	'plattform:administrer'
] as const;

export type Rettighet = (typeof RETTIGHETER)[number];

const KLINISK_LESE = [
	'user/Patient.rs', 'user/Encounter.rs', 'user/Condition.rs', 'user/Observation.rs',
	'user/MedicationRequest.rs', 'user/MedicationStatement.rs', 'user/AllergyIntolerance.rs',
	'user/Immunization.rs', 'user/Procedure.rs', 'user/DiagnosticReport.rs',
	'user/DocumentReference.rs', 'user/Composition.rs', 'user/ServiceRequest.rs',
	'user/CarePlan.rs', 'user/Appointment.rs', 'user/Practitioner.rs', 'user/Organization.rs',
	'user/QuestionnaireResponse.rs', 'user/Flag.rs', 'user/RelatedPerson.rs'
];

const KLINISK_SKRIVE = [
	'user/Encounter.cruds', 'user/Condition.cruds', 'user/Observation.cruds',
	'user/Procedure.cruds', 'user/DocumentReference.cruds', 'user/Composition.cruds',
	'user/ServiceRequest.cruds', 'user/CarePlan.cruds', 'user/QuestionnaireResponse.cruds',
	'user/Flag.cruds', 'user/AllergyIntolerance.cruds', 'user/Immunization.cruds'
];

export const ROLLE_DEFINISJONER: Record<Rolle, RolleDefinisjon> = {
	lege: {
		navn: 'Lege',
		beskrivelse: 'Fastlege med fullt behandleransvar.',
		scopes: [...KLINISK_LESE, ...KLINISK_SKRIVE, 'user/MedicationRequest.cruds', 'user/Patient.cruds', 'user/DiagnosticReport.cruds', 'user/Claim.cruds', 'user/Communication.cruds', 'user/Consent.rs'],
		rettigheter: ['journal:les', 'journal:skriv', 'journal:signer', 'journal:rett', 'journal:slett-begjaering', 'resept:forskriv', 'resept:fornye', 'melding:les', 'melding:send', 'melding:signer', 'oppgjor:registrer', 'time:administrer', 'pasient:opprett', 'pasient:sperr', 'logg:innsyn'],
		kanNodrett: true,
		kanSeAllePasienter: false
	},
	'lege-vikar': {
		navn: 'Vikarlege',
		beskrivelse: 'Lege som dekker et fastlegehjemmel i et avgrenset tidsrom.',
		scopes: [...KLINISK_LESE, ...KLINISK_SKRIVE, 'user/MedicationRequest.cruds', 'user/Claim.cruds', 'user/Communication.cruds'],
		rettigheter: ['journal:les', 'journal:skriv', 'journal:signer', 'resept:forskriv', 'resept:fornye', 'melding:les', 'melding:send', 'melding:signer', 'oppgjor:registrer'],
		kanNodrett: true,
		kanSeAllePasienter: false
	},
	turnuslege: {
		navn: 'LIS1 / turnuslege',
		beskrivelse: 'Lege under spesialisering. Notater kan kreve kontrasignering.',
		scopes: [...KLINISK_LESE, ...KLINISK_SKRIVE, 'user/MedicationRequest.crus'],
		rettigheter: ['journal:les', 'journal:skriv', 'resept:forskriv', 'melding:les', 'melding:send', 'oppgjor:registrer'],
		kanNodrett: true,
		kanSeAllePasienter: false
	},
	sykepleier: {
		navn: 'Sykepleier',
		beskrivelse: 'Utfører selvstendige tiltak og dokumenterer i journal.',
		scopes: [...KLINISK_LESE, ...KLINISK_SKRIVE],
		rettigheter: ['journal:les', 'journal:skriv', 'melding:les', 'melding:send', 'time:administrer', 'oppgjor:registrer'],
		kanNodrett: true,
		kanSeAllePasienter: false
	},
	helsesekretaer: {
		navn: 'Helsesekretær',
		beskrivelse: 'Administrativ oppfølging, timebok og oppgjør. Begrenset innsyn i kliniske notater.',
		scopes: ['user/Patient.rs', 'user/Appointment.cruds', 'user/Encounter.rs', 'user/Communication.rs', 'user/Coverage.rs', 'user/Claim.cruds', 'user/Practitioner.rs', 'user/Organization.rs'],
		rettigheter: ['journal:les', 'melding:les', 'time:administrer', 'pasient:opprett', 'oppgjor:registrer', 'oppgjor:send'],
		kanNodrett: false,
		kanSeAllePasienter: false
	},
	bioingenior: {
		navn: 'Bioingeniør',
		beskrivelse: 'Registrerer prøvesvar og laboratorieundersøkelser.',
		scopes: ['user/Patient.rs', 'user/Observation.cruds', 'user/DiagnosticReport.cruds', 'user/Specimen.cruds', 'user/ServiceRequest.rs'],
		rettigheter: ['journal:les', 'journal:skriv', 'melding:les'],
		kanNodrett: false,
		kanSeAllePasienter: false
	},
	jordmor: {
		navn: 'Jordmor',
		beskrivelse: 'Svangerskapsomsorg.',
		scopes: [...KLINISK_LESE, ...KLINISK_SKRIVE],
		rettigheter: ['journal:les', 'journal:skriv', 'journal:signer', 'melding:les', 'melding:send', 'oppgjor:registrer'],
		kanNodrett: true,
		kanSeAllePasienter: false
	},
	psykolog: {
		navn: 'Psykolog',
		beskrivelse: 'Psykologfaglig utredning og behandling.',
		scopes: [...KLINISK_LESE, ...KLINISK_SKRIVE],
		rettigheter: ['journal:les', 'journal:skriv', 'journal:signer', 'melding:les', 'melding:send', 'oppgjor:registrer'],
		kanNodrett: true,
		kanSeAllePasienter: false
	},
	systemansvarlig: {
		navn: 'Systemansvarlig',
		beskrivelse: 'Drifter journalsystemet. Har ikke klinisk innsyn - kun administrasjon.',
		scopes: ['user/Practitioner.cruds', 'user/PractitionerRole.cruds', 'user/Organization.cruds', 'user/Location.cruds'],
		rettigheter: ['admin:brukere', 'admin:apper', 'admin:system', 'admin:logg'],
		kanNodrett: false,
		kanSeAllePasienter: false
	},
	personvernombud: {
		navn: 'Personvernombud',
		beskrivelse: 'Kontrollerer sikkerhetsloggen og behandler innsynsbegjæringer.',
		scopes: ['user/AuditEvent.rs', 'user/Consent.rs', 'user/Patient.rs'],
		rettigheter: ['admin:logg', 'logg:innsyn'],
		kanNodrett: false,
		kanSeAllePasienter: true
	},
	regnskap: {
		navn: 'Regnskap',
		beskrivelse: 'Fører oppgjør mot Helfo og pasientfakturering.',
		scopes: ['user/Claim.rs', 'user/ClaimResponse.rs', 'user/Invoice.cruds', 'user/Coverage.rs', 'user/Patient.rs'],
		rettigheter: ['oppgjor:registrer', 'oppgjor:send'],
		kanNodrett: false,
		kanSeAllePasienter: false
	},
	systemeier: {
		navn: 'Systemeier',
		beskrivelse:
			'Plattformadministrator. Oppretter og administrerer virksomheter. Har ingen tilgang til journaler i noen virksomhet.',
		scopes: [],
		rettigheter: ['plattform:administrer'],
		kanNodrett: false,
		kanSeAllePasienter: false
	},
	pasient: {
		navn: 'Pasient',
		beskrivelse: 'Innbygger med innsyn i egen journal og egen logg.',
		scopes: ['patient/Patient.rs', 'patient/Observation.rs', 'patient/Condition.rs', 'patient/MedicationRequest.rs', 'patient/AllergyIntolerance.rs', 'patient/Immunization.rs', 'patient/DocumentReference.rs', 'patient/Encounter.rs', 'patient/Appointment.rs', 'patient/AuditEvent.rs'],
		rettigheter: ['logg:innsyn'],
		kanNodrett: false,
		kanSeAllePasienter: false
	}
};

export function erRolle(v: string): v is Rolle {
	return (ROLLER as readonly string[]).includes(v);
}

/** Samlede scopes for et sett roller. */
export function scopesForRoller(roller: Rolle[]): Set<string> {
	const sett = new Set<string>();
	for (const r of roller) for (const s of ROLLE_DEFINISJONER[r]?.scopes ?? []) sett.add(s);
	return sett;
}

export function rettigheterForRoller(roller: Rolle[]): Set<Rettighet> {
	const sett = new Set<Rettighet>();
	for (const r of roller) for (const p of ROLLE_DEFINISJONER[r]?.rettigheter ?? []) sett.add(p);
	return sett;
}

export function kanNodrett(roller: Rolle[]): boolean {
	return roller.some((r) => ROLLE_DEFINISJONER[r]?.kanNodrett);
}

export function kanSeAllePasienter(roller: Rolle[]): boolean {
	return roller.some((r) => ROLLE_DEFINISJONER[r]?.kanSeAllePasienter);
}
