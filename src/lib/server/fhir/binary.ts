import { exec, one } from '../db';
import { requireTenant } from '../tenant/context';

/**
 * Which patient an attachment belongs to.
 *
 * `Binary` has no `subject`, so there is nothing in the resource itself for
 * access control to judge. The link is recorded when the attachment is created
 * and read back whenever one is fetched, which lets an attachment go through
 * exactly the same decision as any other patient resource.
 */

export async function rememberBinaryOwner(
	binaryId: string,
	patientId: string,
	userId: string | null
): Promise<void> {
	await exec(
		`INSERT INTO binary_patient (tenant_id, binary_id, patient_id, created_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (tenant_id, binary_id) DO UPDATE SET patient_id = EXCLUDED.patient_id`,
		[requireTenant().id, binaryId, patientId, userId]
	);
}

/** The patient, or null when nothing has claimed the attachment. */
export async function binaryOwner(binaryId: string): Promise<string | null> {
	const row = await one<{ patient_id: string }>(
		'SELECT patient_id FROM binary_patient WHERE tenant_id = $1 AND binary_id = $2',
		[requireTenant().id, binaryId]
	);
	return row?.patient_id ?? null;
}

export async function forgetBinaryOwner(binaryId: string): Promise<void> {
	await exec('DELETE FROM binary_patient WHERE tenant_id = $1 AND binary_id = $2', [
		requireTenant().id, binaryId
	]);
}
