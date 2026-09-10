import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { smartConfiguration } from '$srv/fhir/smart-configuration';

/**
 * SMART discovery under the FHIR base, which is where the spec puts it.
 *
 * `iss` points at the FHIR endpoint, so this is the address an app resolves
 * first. It is public: an app has to read it before it has any token, and
 * everything in it is already public knowledge about the endpoints.
 */
export const GET: RequestHandler = () =>
	json(smartConfiguration(), { headers: { 'cache-control': 'public, max-age=300' } });
