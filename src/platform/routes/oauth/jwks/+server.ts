import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { jwks } from '$srv/auth/keys';

/** Public keys for verifying access tokens and the id_token. */
export const GET: RequestHandler = async () =>
	json(await jwks(), { headers: { 'cache-control': 'public, max-age=300' } });
