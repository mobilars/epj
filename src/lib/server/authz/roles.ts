/**
 * Role model for a general practice.
 *
 * The EPJ standard (access control, correction and deletion) requires access to
 * be granted from role and legitimate need, not from whoever happens to be
 * signed in. The roles here define *what kind of* information a staff category
 * may see; `access.ts` then decides *which patients* it covers.
 */

export const ROLES = [
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
	// Platform level: belongs to no organisation, and never has clinical access.
	'systemeier'
] as const;

export type Role = (typeof ROLES)[number];

export interface RoleDefinisjon {
	name: string;
	description: string;
	/** The most a role can be granted through a SMART app. */
	scopes: string[];
	/** System functions outside the FHIR API. */
	permissions: Permission[];
	/** The role may use emergency access (break the glass). */
	canEmergencyAccess: boolean;
	/** The role may see record content without a registered care relationship. */
	canSeeAllPatients: boolean;
}

export const PERMISSIONS = [
	'journal:les',
	'journal:skriv',
	'journal:signer',
	'journal:rett',
	'journal:slett-begjaering',
	'journal:utlever',
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

export type Permission = (typeof PERMISSIONS)[number];

const CLINICAL_LESE = [
	'user/Patient.rs', 'user/Encounter.rs', 'user/Condition.rs', 'user/Observation.rs',
	'user/MedicationRequest.rs', 'user/MedicationStatement.rs', 'user/AllergyIntolerance.rs',
	'user/Immunization.rs', 'user/Procedure.rs', 'user/DiagnosticReport.rs',
	'user/DocumentReference.rs', 'user/Composition.rs', 'user/ServiceRequest.rs',
	'user/CarePlan.rs', 'user/Appointment.rs', 'user/Practitioner.rs', 'user/Organization.rs',
	'user/QuestionnaireResponse.rs', 'user/Flag.rs', 'user/RelatedPerson.rs'
];

const CLINICAL_SKRIVE = [
	'user/Encounter.cruds', 'user/Condition.cruds', 'user/Observation.cruds',
	'user/Procedure.cruds', 'user/DocumentReference.cruds', 'user/Composition.cruds',
	'user/ServiceRequest.cruds', 'user/CarePlan.cruds', 'user/QuestionnaireResponse.cruds',
	'user/Flag.cruds', 'user/AllergyIntolerance.cruds', 'user/Immunization.cruds'
];

export const ROLE_DEFINISJONER: Record<Role, RoleDefinisjon> = {
	lege: {
		name: 'Lege',
		description: 'Fastlege med fullt behandleransvar.',
		scopes: [...CLINICAL_LESE, ...CLINICAL_SKRIVE, 'user/MedicationRequest.cruds', 'user/Patient.cruds', 'user/DiagnosticReport.cruds', 'user/Claim.cruds', 'user/Communication.cruds', 'user/Consent.rs'],
		permissions: ['journal:les', 'journal:skriv', 'journal:signer', 'journal:rett', 'journal:slett-begjaering', 'journal:utlever', 'resept:forskriv', 'resept:fornye', 'melding:les', 'melding:send', 'melding:signer', 'oppgjor:registrer', 'time:administrer', 'pasient:opprett', 'pasient:sperr', 'logg:innsyn'],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},
	'lege-vikar': {
		name: 'Vikarlege',
		description: 'Lege som dekker et fastlegehjemmel i et avgrenset tidsrom.',
		scopes: [...CLINICAL_LESE, ...CLINICAL_SKRIVE, 'user/MedicationRequest.cruds', 'user/Claim.cruds', 'user/Communication.cruds'],
		permissions: ['journal:les', 'journal:skriv', 'journal:signer', 'journal:utlever', 'resept:forskriv', 'resept:fornye', 'melding:les', 'melding:send', 'melding:signer', 'oppgjor:registrer'],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},
	turnuslege: {
		name: 'LIS1 / turnuslege',
		description: 'Lege under spesialisering. Notater kan kreve kontrasignering.',
		scopes: [...CLINICAL_LESE, ...CLINICAL_SKRIVE, 'user/MedicationRequest.crus'],
		permissions: ['journal:les', 'journal:skriv', 'resept:forskriv', 'melding:les', 'melding:send', 'oppgjor:registrer'],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},
	sykepleier: {
		name: 'Sykepleier',
		description: 'Utfører selvstendige tiltak og dokumenterer i journal.',
		scopes: [...CLINICAL_LESE, ...CLINICAL_SKRIVE],
		permissions: ['journal:les', 'journal:skriv', 'melding:les', 'melding:send', 'time:administrer', 'oppgjor:registrer'],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},
	helsesekretaer: {
		name: 'Helsesekretær',
		description: 'Administrativ oppfølging, timebok og oppgjør. Begrenset innsyn i kliniske notater.',
		scopes: ['user/Patient.rs', 'user/Appointment.cruds', 'user/Encounter.rs', 'user/Communication.rs', 'user/Coverage.rs', 'user/Claim.cruds', 'user/Practitioner.rs', 'user/Organization.rs'],
		permissions: ['journal:les', 'journal:utlever', 'melding:les', 'time:administrer', 'pasient:opprett', 'oppgjor:registrer', 'oppgjor:send'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},
	bioingenior: {
		name: 'Bioingeniør',
		description: 'Registrerer prøvesvar og laboratorieundersøkelser.',
		scopes: ['user/Patient.rs', 'user/Observation.cruds', 'user/DiagnosticReport.cruds', 'user/Specimen.cruds', 'user/ServiceRequest.rs'],
		permissions: ['journal:les', 'journal:skriv', 'melding:les'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},
	jordmor: {
		name: 'Jordmor',
		description: 'Svangerskapsomsorg.',
		scopes: [...CLINICAL_LESE, ...CLINICAL_SKRIVE],
		permissions: ['journal:les', 'journal:skriv', 'journal:signer', 'journal:utlever', 'melding:les', 'melding:send', 'oppgjor:registrer'],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},
	psykolog: {
		name: 'Psykolog',
		description: 'Psykologfaglig utredning og behandling.',
		scopes: [...CLINICAL_LESE, ...CLINICAL_SKRIVE],
		permissions: ['journal:les', 'journal:skriv', 'journal:signer', 'journal:utlever', 'melding:les', 'melding:send', 'oppgjor:registrer'],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},
	systemansvarlig: {
		name: 'Systemansvarlig',
		description: 'Drifter journalsystemet. Har ikke klinisk innsyn - kun administrasjon.',
		scopes: ['user/Practitioner.cruds', 'user/PractitionerRole.cruds', 'user/Organization.cruds', 'user/Location.cruds'],
		permissions: ['admin:brukere', 'admin:apper', 'admin:system', 'admin:logg'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},
	personvernombud: {
		name: 'Personvernombud',
		description: 'Kontrollerer sikkerhetsloggen og behandler innsynsbegjæringer.',
		scopes: ['user/AuditEvent.rs', 'user/Consent.rs', 'user/Patient.rs'],
		permissions: ['admin:logg', 'logg:innsyn', 'journal:utlever'],
		canEmergencyAccess: false,
		canSeeAllPatients: true
	},
	regnskap: {
		name: 'Regnskap',
		description: 'Fører oppgjør mot Helfo og pasientfakturering.',
		scopes: ['user/Claim.rs', 'user/ClaimResponse.rs', 'user/Invoice.cruds', 'user/Coverage.rs', 'user/Patient.rs'],
		permissions: ['oppgjor:registrer', 'oppgjor:send'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},
	systemeier: {
		name: 'Systemeier',
		description:
			'Plattformadministrator. Oppretter og administrerer virksomheter. Har ingen tilgang til journaler i noen virksomhet.',
		scopes: [],
		permissions: ['plattform:administrer'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},
	pasient: {
		name: 'Pasient',
		description: 'Innbygger med innsyn i egen journal og egen logg.',
		scopes: ['patient/Patient.rs', 'patient/Observation.rs', 'patient/Condition.rs', 'patient/MedicationRequest.rs', 'patient/AllergyIntolerance.rs', 'patient/Immunization.rs', 'patient/DocumentReference.rs', 'patient/Encounter.rs', 'patient/Appointment.rs', 'patient/AuditEvent.rs'],
		permissions: ['logg:innsyn', 'journal:utlever'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	}
};

export function isRole(v: string): v is Role {
	return (ROLES as readonly string[]).includes(v);
}

/** Combined scopes for a set of roles. */
export function scopesForRoles(roles: Role[]): Set<string> {
	const set = new Set<string>();
	for (const r of roles) for (const s of ROLE_DEFINISJONER[r]?.scopes ?? []) set.add(s);
	return set;
}

export function permissionsForRoles(roles: Role[]): Set<Permission> {
	const set = new Set<Permission>();
	for (const r of roles) for (const p of ROLE_DEFINISJONER[r]?.permissions ?? []) set.add(p);
	return set;
}

export function canEmergencyAccess(roles: Role[]): boolean {
	return roles.some((r) => ROLE_DEFINISJONER[r]?.canEmergencyAccess);
}

export function canSeeAllPatients(roles: Role[]): boolean {
	return roles.some((r) => ROLE_DEFINISJONER[r]?.canSeeAllPatients);
}
