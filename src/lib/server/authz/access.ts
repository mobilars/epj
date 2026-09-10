import { one, query } from '../db';
import { requireTenant } from '../tenant/context';
import { PATIENTCOMPARTMENT } from '../fhir/searchparams';
import { getValues, parseReference } from '../fhir/fhirpath';
import type { FhirResource } from '../fhir/types';
import { isPatient, ownPatientId, type AuthContext } from './context';
import { canSeeAllPatients } from './roles';
import { checkScope, type Operation } from './scopes';

/**
 * The access decision.
 *
 * Four layers must all agree before a request gets through:
 *
 *  1. Scope        - what the app asked for and was granted (SMART on FHIR)
 *  2. Role         - what the staff category may do (the EPJ standard)
 *  3. Legitimate need - whether a documented care relationship exists with
 *                    this particular patient (helsepersonelloven § 21 a)
 *  4. Restriction  - whether the patient has blocked the record for this user
 *
 * Emergency access ("break the glass") can override layers 3 and 4, but never
 * 1 and 2, and always with a justification, a time limit and its own entry in
 * the audit log.
 */
export type Basis =
	| 'behandlingsrelasjon'
	| 'egen-journal'
	| 'nodrett'
	| 'administrativ-rolle'
	| 'pasientregistrering'
	| 'ikke-pasientdata';

export interface Decision {
	allowed: boolean;
	reason?: string;
	basis?: Basis;
	/** `TREAT` normally, `ETREAT` under emergency access - goes in AuditEvent.purposeOfUse. */
	purposeOfUse: string;
	/** Search limitations from scope that must be forced into the query. */
	limitations: URLSearchParams[];
	/** HTTP status to return when `allowed` is false. */
	status: 401 | 403;
}

const DENY = (reason: string, status: 401 | 403 = 403): Decision => ({
	allowed: false, reason, purposeOfUse: 'TREAT', limitations: [], status
});

/**
 * Resource types that hold no patient data and therefore need no legitimate
 * need.
 *
 * The list should stay short and easy to defend. A type belongs here only if it
 * cannot point at a patient at all - `Group` used to be here, but a group can
 * carry `member.entity` referencing Patient, and a cohort extract is precisely
 * a list of who belongs to it.
 */
const NOT_PASIENTNAERE = new Set([
	'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication',
	'Questionnaire', 'Schedule', 'Slot', 'Subscription', 'CapabilityStatement',
	'StructureDefinition', 'ValueSet', 'CodeSystem'
]);

/**
 * Whether access control can determine which patient a resource type concerns.
 *
 * Both legitimate need (layer 3) and restriction (layer 4) assume we know which
 * patient the information belongs to. For a type with no patient reference in
 * the compartment definition neither can be enforced - and then the type should
 * not be available at all, whatever the scope says.
 *
 * This is a structural bar, not a list to maintain: a new resource type in
 * SEARCH_PARAMS without a `patient`/`subject` parameter is refused until
 * somebody has decided how its patient is to be derived.
 */
export function canDeterminePatient(resourceType: string): boolean {
	if (resourceType === 'Patient') return true;
	return (PATIENTCOMPARTMENT[resourceType]?.length ?? 0) > 0;
}

/** Whether a resource type carries patient data at all. */
export function isPatientRelated(resourceType: string): boolean {
	return !NOT_PASIENTNAERE.has(resourceType);
}

/** Finds the patient a resource concerns, from the compartment definition. */
export function patientIdFromResource(resource: FhirResource): string | null {
	if (resource.resourceType === 'Patient') return (resource.id as string) ?? null;
	for (const param of PATIENTCOMPARTMENT[resource.resourceType] ?? []) {
		for (const path of [param, param === 'patient' ? 'patient' : 'subject']) {
			for (const v of getValues(resource, path)) {
				const ref = parseReference(v);
				if (ref && (ref.type === 'Patient' || ref.type === null)) return ref.id;
			}
		}
	}
	return null;
}

export interface AccessQuestion {
	ctx: AuthContext;
	resourceType: string;
	operation: Operation;
	/** Set when the request concerns one known patient. */
	patientId?: string | null;
	/** The resource being read or written, when it is known. */
	resource?: FhirResource | null;
	/** Resource id for calls that have not fetched the content yet. */
	resourceId?: string | null;
}

export async function evaluate(question: AccessQuestion): Promise<Decision> {
	const { ctx, resourceType, operation } = question;

	// --- Layer 1: scope -----------------------------------------------------
	const patientId = question.patientId ?? (question.resource ? patientIdFromResource(question.resource) : null);
	// For a citizen logged into their own record the patient context is the
	// person themselves, even when there is no SMART launch.
	const contextPatient = ctx.launch.patientId ?? ownPatientId(ctx);
	const scopeResponse = checkScope(ctx.scopes, {
		resource: resourceType,
		operation,
		contextPatientId: patientId,
		tokenPatientId: contextPatient
	});
	if (!scopeResponse.allowed) return DENY(scopeResponse.reason ?? 'Mangler scope');

	// --- Lag 2: rolle -------------------------------------------------------
	const writes = operation === 'c' || operation === 'u' || operation === 'd';

	/**
	 * Registering a patient is the one write with no patient to judge against.
	 * The record does not exist yet, so there is no care relationship to have
	 * and nothing that could be restricted - the three layers below have
	 * nothing to work on. The role's own `pasient:opprett` decides instead.
	 *
	 * It is deliberately not `journal:skriv`: the front desk registers patients
	 * without being allowed to write in anyone's record. Whoever registers the
	 * patient records a care relationship at the same time, which is what gives
	 * them access to the record afterwards - and leaves the trace that says why.
	 */
	const registersPatient = operation === 'c' && resourceType === 'Patient' && !patientId;
	if (registersPatient) {
		if (!ctx.permissions.has('pasient:opprett')) {
			return DENY('Rollen din kan ikke registrere nye pasienter');
		}
		return { allowed: true, basis: 'pasientregistrering', purposeOfUse: 'TREAT', limitations: scopeResponse.limitations, status: 403 };
	}

	if (writes && !ctx.permissions.has('journal:skriv') && !ctx.permissions.has('admin:system')) {
		return DENY('Rollen din har ikke skriverettigheter i journal');
	}
	if (!writes && !ctx.permissions.has('journal:les') && !ctx.permissions.has('admin:logg') && !ctx.permissions.has('logg:innsyn')) {
		return DENY('Rollen din har ikke leserettigheter i journal');
	}

	if (NOT_PASIENTNAERE.has(resourceType)) {
		return { allowed: true, basis: 'ikke-pasientdata', purposeOfUse: 'HOPERAT', limitations: scopeResponse.limitations, status: 403 };
	}

	// The type carries patient data, but we have no way to find out which
	// patient. Neither legitimate need nor restriction can be judged, and the
	// only defensible answer is no.
	if (!canDeterminePatient(resourceType)) {
		return DENY(`Tilgangen til ${resourceType} kan ikke vurderes: ressurstypen har ingen pasientreferanse`);
	}

	// A citizen viewing their own record.
	if (isPatient(ctx)) {
		const own = ownPatientId(ctx);
		if (!own) return DENY('Innbyggerbrukeren mangler kobling til pasientjournal');
		if (patientId && patientId !== own) return DENY('Du har bare tilgang til din egen journal');
		if (writes) return DENY('Innbyggere kan ikke endre journalinnhold');
		return { allowed: true, basis: 'egen-journal', purposeOfUse: 'PATRQT', limitations: scopeResponse.limitations, status: 403 };
	}

	if (!patientId) {
		// A search has no patient up front. Access is decided per hit, by
		// `searchResources` narrowing the query with `allowedPatients()`.
		if (operation === 's') {
			return { allowed: true, basis: 'behandlingsrelasjon', purposeOfUse: 'TREAT', limitations: scopeResponse.limitations, status: 403 };
		}
		// A single lookup of a patient-bearing resource with no patient
		// reference can be judged against neither care relationship nor
		// restriction. Such calls used to pass, which made legitimate need
		// evadable for any resource whose reference was missing or unrecognised.
		return DENY(`Fant ingen pasientreferanse i ${resourceType}, og tilgangen kan derfor ikke vurderes`);
	}

	// --- Layer 3: legitimate need -------------------------------------------
	const emergencyAccess = await activeEmergencyAccess(ctx.userId, patientId);
	const hasRelationship = canSeeAllPatients(ctx.roles) || (await hasCareRelationship(ctx.userId, patientId));

	if (!hasRelationship && !emergencyAccess) {
		return DENY('Ingen dokumentert behandlingsrelasjon til denne pasienten. Bruk nødrettstilgang hvis situasjonen krever det.');
	}

	// --- Lag 4: sperring ----------------------------------------------------
	const blocked = await isBlocked(ctx, patientId, question.resource ?? null, question.resourceId ?? null);
	if (blocked && !emergencyAccess) {
		return DENY('Pasienten har sperret disse opplysningene for deg');
	}

	if (emergencyAccess) {
		return { allowed: true, basis: 'nodrett', purposeOfUse: 'ETREAT', limitations: scopeResponse.limitations, status: 403 };
	}
	return {
		allowed: true,
		basis: canSeeAllPatients(ctx.roles) ? 'administrativ-rolle' : 'behandlingsrelasjon',
		purposeOfUse: 'TREAT',
		limitations: scopeResponse.limitations,
		status: 403
	};
}

export async function hasCareRelationship(userId: string | null, patientId: string): Promise<boolean> {
	if (!userId) return false;
	const row = await one<{ n: string }>(
		`SELECT 1 AS n FROM care_relationship
		 WHERE tenant_id = $1 AND user_id = $2 AND patient_id = $3
		   AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
		 LIMIT 1`,
		[requireTenant().id, userId, patientId]
	);
	return row !== null;
}

export async function activeEmergencyAccess(userId: string | null, patientId: string): Promise<boolean> {
	if (!userId) return false;
	const row = await one<{ n: string }>(
		'SELECT 1 AS n FROM break_glass WHERE tenant_id = $1 AND user_id = $2 AND patient_id = $3 AND expires_at > now() LIMIT 1',
		[requireTenant().id, userId, patientId]
	);
	return row !== null;
}

export async function isBlocked(
	ctx: AuthContext,
	patientId: string,
	resource: FhirResource | null,
	resourceId: string | null
): Promise<boolean> {
	const restrictions = await query<{ scope_extent: string; target_user_id: string | null; target_role: string | null; target_resource: string | null }>(
		`SELECT scope_extent, target_user_id, target_role, target_resource FROM record_restriction
		 WHERE tenant_id = $1 AND patient_id = $2 AND lifted = false
		   AND (valid_until IS NULL OR valid_until > now())`,
		[requireTenant().id, patientId]
	);
	if (restrictions.length === 0) return false;
	const resourceKey = resource ? `${resource.resourceType}/${resource.id}` : resourceId;
	for (const s of restrictions) {
		switch (s.scope_extent) {
			case 'alle':
				return true;
			case 'bruker':
				if (s.target_user_id && s.target_user_id === ctx.userId) return true;
				break;
			case 'rolle':
				if (s.target_role && ctx.roles.includes(s.target_role as never)) return true;
				break;
			case 'dokument':
				if (s.target_resource && resourceKey && s.target_resource === resourceKey) return true;
				break;
		}
	}
	return false;
}

/**
 * The patients this user has a legitimate need for right now. Used to force a
 * `patient=` filter into searches, so that a broad search can never leak
 * patients the user has no relationship with.
 */
export async function allowedPatients(ctx: AuthContext, max = 2000): Promise<string[] | 'alle'> {
	if (canSeeAllPatients(ctx.roles)) return 'alle';
	if (isPatient(ctx)) {
		const own = ownPatientId(ctx);
		return own ? [own] : [];
	}
	if (ctx.launch.patientId && ctx.scopes.clinical.every((s) => s.context === 'patient')) {
		return [ctx.launch.patientId];
	}
	const rows = await query<{ patient_id: string }>(
		`SELECT DISTINCT patient_id FROM care_relationship
		 WHERE tenant_id = $1 AND user_id = $2 AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
		 UNION
		 SELECT DISTINCT patient_id FROM break_glass
		 WHERE tenant_id = $1 AND user_id = $2 AND expires_at > now()
		 LIMIT $3`,
		[requireTenant().id, ctx.userId, max]
	);
	return rows.map((r) => r.patient_id);
}

/** Patients who have blocked the record for this user, and must be filtered out. */
export async function blockedPatients(ctx: AuthContext): Promise<Set<string>> {
	const rows = await query<{ patient_id: string; scope_extent: string; target_user_id: string | null; target_role: string | null }>(
		`SELECT patient_id, scope_extent, target_user_id, target_role FROM record_restriction
		 WHERE tenant_id = $1 AND lifted = false AND (valid_until IS NULL OR valid_until > now())
		   AND scope_extent IN ('alle','bruker','role')`,
		[requireTenant().id]
	);
	const blocked = new Set<string>();
	for (const s of rows) {
		if (s.scope_extent === 'alle') blocked.add(s.patient_id);
		else if (s.scope_extent === 'bruker' && s.target_user_id === ctx.userId) blocked.add(s.patient_id);
		else if (s.scope_extent === 'rolle' && s.target_role && ctx.roles.includes(s.target_role as never)) blocked.add(s.patient_id);
	}
	if (blocked.size === 0 || !ctx.userId) return blocked;
	// Emergency access lifts the restriction for the patients it covers.
	const emergencyAccess = await query<{ patient_id: string }>(
		'SELECT patient_id FROM break_glass WHERE tenant_id = $1 AND user_id = $2 AND expires_at > now()',
		[requireTenant().id, ctx.userId]
	);
	for (const n of emergencyAccess) blocked.delete(n.patient_id);
	return blocked;
}
