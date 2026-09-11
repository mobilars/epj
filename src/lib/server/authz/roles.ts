/**
 * Role model for a general practice.
 *
 * The EPJ standard (access control, correction and deletion) requires access to
 * be granted from role and legitimate need, not from whoever happens to be
 * signed in. A role here says *what kind of* information someone may see;
 * `access.ts` then decides *which patients* it covers.
 *
 * The roles are named after what people need to reach, not after what they are
 * qualified as. There were thirteen, one per profession - lege, lege-vikar,
 * turnuslege, sykepleier, jordmor, psykolog - and between several of them there
 * was no difference at all in what they could see. A distinction the system
 * never acts on is not a distinction; it is a longer list to get wrong.
 *
 * Four roles at a practice, named by what they open:
 *
 *   behandler        gives care and writes in the record
 *   lab              records results and measurements
 *   resepsjon        appointments, messages, settlement, registering patients
 *   systemansvarlig  users, apps, logs - no record content at all
 *
 * Two more sit outside that: `pasient` is the patient's own access to their own
 * record, and `systemeier` administers the platform and belongs to no practice.
 *
 * One consequence is deliberate and worth stating plainly: `behandler` carries
 * `resept:forskriv`, so a nurse holding it can prescribe. Prescribing is
 * restricted by law to particular professions, and a model built on access does
 * not know professions. Where that matters the answer is not a longer role list
 * but the HPR number the record already holds - see docs/todo.md.
 */

export const ROLES = [
	'behandler',
	'lab',
	'resepsjon',
	'systemansvarlig',
	// The patient's own access to their own record. Not a staff role.
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
	behandler: {
		name: 'Behandler',
		description:
			'Gir helsehjelp og skriver i journalen. Lege, sykepleier, jordmor, psykolog - rollen sier hva du får se, ikke hva du er utdannet til.',
		scopes: [
			...CLINICAL_LESE,
			...CLINICAL_SKRIVE,
			'user/MedicationRequest.cruds',
			'user/Patient.cruds',
			'user/Claim.cruds',
			'user/Communication.cruds',
			'user/Consent.rs'
		],
		permissions: [
			'journal:les', 'journal:skriv', 'journal:signer', 'journal:rett', 'journal:slett-begjaering',
			'journal:utlever', 'resept:forskriv', 'resept:fornye', 'melding:les', 'melding:send',
			'melding:signer', 'oppgjor:registrer', 'time:administrer', 'pasient:opprett', 'pasient:sperr',
			'logg:innsyn'
		],
		canEmergencyAccess: true,
		canSeeAllPatients: false
	},

	lab: {
		name: 'Lab',
		description:
			'Registrerer prøvesvar og målinger. Ser det som trengs for å knytte et svar til riktig pasient og rekvisisjon, ikke journalen for øvrig.',
		scopes: [
			'user/Patient.rs', 'user/Encounter.rs', 'user/ServiceRequest.rs', 'user/Practitioner.rs',
			'user/Organization.rs', 'user/Observation.cruds', 'user/DiagnosticReport.cruds'
		],
		permissions: ['journal:les', 'journal:skriv', 'melding:les'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},

	resepsjon: {
		name: 'Resepsjon',
		description:
			'Timebok, meldinger, oppgjør og registrering av pasienter. Ser at pasienten finnes og hva som skal betales - ikke hva som står i notatene.',
		scopes: [
			'user/Patient.crs', 'user/Appointment.cruds', 'user/Encounter.rs', 'user/Communication.rs',
			'user/Coverage.rs', 'user/Claim.cruds', 'user/Practitioner.rs', 'user/Organization.rs'
		],
		permissions: [
			'journal:les', 'journal:utlever', 'melding:les', 'time:administrer', 'pasient:opprett',
			'oppgjor:registrer', 'oppgjor:send'
		],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},

	systemansvarlig: {
		name: 'Systemansvarlig',
		description:
			'Brukere, apper, logg og drift. Ingen tilgang til journalinnhold i det hele tatt - heller ikke ved nødrett.',
		scopes: [],
		permissions: ['admin:brukere', 'admin:apper', 'admin:system', 'admin:logg', 'logg:innsyn'],
		canEmergencyAccess: false,
		canSeeAllPatients: false
	},

	pasient: {
		name: 'Pasient',
		description: 'Innbygger med innsyn i egen journal og egen logg.',
		scopes: [
			'patient/Patient.rs', 'patient/Observation.rs', 'patient/Condition.rs',
			'patient/MedicationRequest.rs', 'patient/AllergyIntolerance.rs', 'patient/Immunization.rs',
			'patient/DocumentReference.rs', 'patient/Encounter.rs', 'patient/Appointment.rs',
			'patient/AuditEvent.rs'
		],
		permissions: ['logg:innsyn', 'journal:utlever'],
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
	}
};

export function isRole(v: string): v is Role {
	return (ROLES as readonly string[]).includes(v);
}

/**
 * Roles that belong to the platform, not to a practice.
 *
 * `systemeier` administers the organisations themselves. It must therefore be
 * granted from platform administration only - a practice's own administrator
 * offering it in their user list would let them hand out authority over every
 * other practice on the installation. The role's reach is already bounded by
 * the platform having its own hostname and its own set of accounts, but a
 * permission nobody can grant by mistake is worth more than one that merely
 * fails to work.
 */
export const PLATFORM_ROLES: readonly Role[] = ['systemeier'];

export function isPlatformRole(role: Role): boolean {
	return PLATFORM_ROLES.includes(role);
}

/** The roles a practice's own user administration may hand out. */
export const TENANT_ROLES: readonly Role[] = ROLES.filter((r) => !isPlatformRole(r));

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
