import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { en } from '$srv/db';
import { fhirKlient } from '$srv/fhir/client';
import { gjeldendeVersjon } from '$srv/db/migrate';

/**
 * Helsesjekk for lastbalanserer og overvåking.
 *
 * Svarer aldri med detaljer om interne adresser eller versjoner av
 * tredjepartskomponenter - bare om avhengighetene svarer.
 */
export const GET: RequestHandler = async () => {
	const [database, fhir] = await Promise.all([
		en<{ n: number }>('SELECT 1 AS n').then(() => true).catch(() => false),
		fhirKlient.erTilgjengelig()
	]);
	const skjema = database ? await gjeldendeVersjon().catch(() => 0) : 0;
	const friskt = database && fhir;

	return json(
		{ status: friskt ? 'ok' : 'nede', database, fhir, skjemaversjon: skjema },
		{ status: friskt ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
