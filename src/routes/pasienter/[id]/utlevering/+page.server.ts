import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { UTLEVERINGSGRUNNER } from '$srv/journal/disclosure';
import { getLog } from '$srv/audit';

/**
 * Utlevering av journal.
 *
 * Siden viser hva som skal til for en utlevering, og hvilke utleveringer som
 * allerede er gjort på denne pasienten. Utleveringshistorikken er en del av
 * pasientens innsynsrett: hun skal kunne se hvem journalen hennes har gått til.
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
