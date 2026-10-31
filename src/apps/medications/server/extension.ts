import { exec } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';

export const medicationsExtension = {
	/** The record of what was sent to SFM follows the patient. */
	movePatient: async (from: string, to: string) => {
		await exec('UPDATE sfm_sync SET patient_id = $3 WHERE tenant_id = $1 AND patient_id = $2', [requireTenant().id, from, to]);
	}
};
