import type { PageServerLoad } from './$types';
import { config } from '$srv/config';

/**
 * The written offer of source, required by AGPL section 13.
 *
 * Reachable without signing in: the right belongs to everyone who interacts
 * with the system over a network, and demanding a login first would be a
 * condition the licence does not allow.
 */
export const load: PageServerLoad = async () => {
	return {
		sourceUrl: config.sourceUrl,
		version: config.version
	};
};
