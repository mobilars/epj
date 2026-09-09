import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { erKonfigurert, startPalogging } from '$srv/auth/helseid';

/** Starter HelseID-pålogging. */
export const GET: RequestHandler = async (event) => {
	if (!erKonfigurert()) error(503, 'HelseID er ikke konfigurert i dette miljøet');
	const retur = event.url.searchParams.get('retur') ?? '/';
	const url = await startPalogging(event.cookies, retur.startsWith('/') && !retur.startsWith('//') ? retur : '/');
	redirect(303, url);
};
