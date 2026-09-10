import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { smartConfiguration } from '$srv/fhir/smart-configuration';

/** SMART discovery at the site root, for people looking for it by hand. */
export const GET: RequestHandler = () =>
	json(smartConfiguration(), { headers: { 'cache-control': 'public, max-age=300' } });
