import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isKonfigurert, startLogin } from '$srv/auth/helseid';

/** Starts HelseID sign-in. */
export const GET: RequestHandler = async (event) => {
	if (!isKonfigurert()) error(503, 'HelseID er ikke konfigurert i dette miljøet');
	const returnTo = event.url.searchParams.get('retur') ?? '/';
	const url = await startLogin(event.cookies, returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
	redirect(303, url);
};
