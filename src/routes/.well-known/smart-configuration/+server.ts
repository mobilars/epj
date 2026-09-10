import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { smartConfiguration } from '$srv/fhir/smart-configuration';

/** SMART discovery at the site root, for people looking for it by hand. */

/**
 * Readable from anywhere.
 *
 * An app has to read this before it holds any token, and often before it is
 * registered anywhere - discovery is how it finds out where to register. There
 * is nothing in the document that is not already public: the addresses of
 * endpoints that each enforce their own access control.
 */
const CORS = {
	'cache-control': 'public, max-age=300',
	'access-control-allow-origin': '*'
};

export const GET: RequestHandler = () => json(smartConfiguration(), { headers: CORS });

/** Some clients preflight even a simple GET. */
export const OPTIONS: RequestHandler = () =>
	new Response(null, {
		status: 204,
		headers: {
			'access-control-allow-origin': '*',
			'access-control-allow-methods': 'GET, OPTIONS',
			'access-control-allow-headers': 'accept, content-type',
			'access-control-max-age': '600'
		}
	});

