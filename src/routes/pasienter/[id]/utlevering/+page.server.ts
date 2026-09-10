import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { UTLEVERINGSGRUNNER } from '$srv/journal/disclosure';
import { getLog } from '$srv/audit';

/**
 * Disclosure of the record.
 *
 * The page shows what a disclosure requires, and which disclosures have
 * already been made for this patient. The disclosure history is part of the
 * patient's right of access: they can see where their record has gone.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('journal:utlever')) error(403, 'Rollen din kan ikke utlevere journal.');

	const log = await getLog({ patientId: event.params.id, type: 'utlevering', limit: 25 });

	return {
		grunner: UTLEVERINGSGRUNNER,
		earlier: log.rows.map((r) => ({
			seq: r.seq,
			timestamp: new Date(r.recorded).toLocaleString('nb-NO'),
			hvem: r.actor_name ?? 'ukjent',
			reason: (r.subtype ?? '').replace(/^journal:/, ''),
			purposeOfUse: r.purpose_of_use ?? '',
			reference: (r.entity_ref ?? '').replace(/^Bundle\//, '')
		}))
	};
};
