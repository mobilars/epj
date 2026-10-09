import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OPEN_PATH } from '$srv/journal/openlink';

/**
 * Forgives an address with something after `/apne/pasient`.
 *
 * The usual cause is an integration whose base address was set to the whole
 * link rather than to the site, so the path comes out twice:
 * `/apne/pasient/apne/pasient#phone=…`. A 404 there tells the person at the
 * switchboard nothing, and the call is already ringing.
 *
 * The redirect carries the query string. The fragment - where the phone number
 * or national identity number is - never reached this server; the browser
 * keeps it and applies it to the address it is sent on to, which is this same
 * site. Every check then happens on the real page, as if the address had been
 * right from the start.
 */
export const GET: RequestHandler = ({ url }) => {
	redirect(307, `${OPEN_PATH}${url.search}`);
};
