import { exec } from '../db';
import type { AuthContext } from '../authz/context';
import { blockedPatients } from '../authz/access';
import { fhirClient } from '../fhir/client';
import { toPatientDisplay } from '../fhir/display';
import { resources } from '../fhir/internal';
import { requireTenant } from '../tenant/context';
import { newId } from '../util/ids';

/**
 * A clinician at the practice taking on a patient.
 *
 * Legitimate need (tjenstlig behov: the legal requirement that access follows from
 * actually treating the patient) is recorded as a care relationship. Clinicians in
 * the same practice may add themselves without anyone approving it, since the person
 * who knows they are treating the patient is the clinician, and a colleague taking
 * over a consultation cannot wait for an administrator. What holds this to account
 * is the security log, and the patient's own access log, rather than a check
 * beforehand.
 *
 * A restriction (sperring) still applies. A patient who has blocked this user is
 * not offered, and a relationship would not open the record anyway.
 */

/** What is shown before anyone has access: enough to pick the right person, no more. */
export interface PatientToJoin {
	id: string;
	name: string;
	nationalIdMasked: string | null;
	age: number | null;
}

/**
 * Patients at the practice this user has no relationship with.
 *
 * Goes around the guard on purpose, since the guard is what hides them. That is why
 * this returns only the fields above, and why the caller logs the search.
 */
export async function patientsToJoin(ctx: AuthContext, search: URLSearchParams, alreadyVisible: Set<string>): Promise<PatientToJoin[]> {
	const [bundle, blocked] = await Promise.all([fhirClient.search('Patient', search), blockedPatients(ctx)]);
	return resources(bundle)
		.map(toPatientDisplay)
		.filter((patient) => !alreadyVisible.has(patient.id) && !blocked.has(patient.id))
		.map(({ id, name, nationalIdMasked, age }) => ({ id, name, nationalIdMasked, age }));
}

export async function mayJoinPatient(ctx: AuthContext, patientId: string): Promise<boolean> {
	return ctx.permissions.has('pasient:tilknytt') && !(await blockedPatients(ctx)).has(patientId);
}

/** Pressing the button twice leaves one relationship. */
export async function registerAsCarer(userId: string, patientId: string): Promise<void> {
	const tenantId = requireTenant().id;
	await exec(
		`INSERT INTO care_relationship (id, tenant_id, user_id, patient_id, basis, created_by)
		 SELECT $1, $2, $3, $4, 'selvregistrert', $3
		 WHERE NOT EXISTS (
			SELECT 1 FROM care_relationship
			WHERE tenant_id = $2 AND user_id = $3 AND patient_id = $4
			  AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
		 )`,
		[newId(), tenantId, userId, patientId]
	);
}
