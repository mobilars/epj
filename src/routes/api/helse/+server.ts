import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { one } from '$srv/db';
import { fhirClient } from '$srv/fhir/client';
import { currentVersion } from '$srv/db/migrate';

/**
 * Helsesjekk for lastbalanserer og overvåking.
 *
 * Svarer aldri med detaljer om interne adresser eller versjoner av
 * tredjepartskomponenter - bare om avhengighetene svarer.
 */
export const GET: RequestHandler = async () => {
	const [database, fhir] = await Promise.all([
		one<{ n: number }>('SELECT 1 AS n').then(() => true).catch(() => false),
		fhirClient.isTilgjengelig()
	]);
	const schema = database ? await currentVersion().catch(() => 0) : 0;
	const friskt = database && fhir;

	return json(
		{ status: friskt ? 'ok' : 'nede', database, fhir, schemaVersion: schema },
		{ status: friskt ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
