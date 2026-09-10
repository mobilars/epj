import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { endSession } from '$srv/auth/session';
import { log } from '$srv/audit';
import { actorFromContext } from '$srv/audit';

export const POST: RequestHandler = async (event) => {
	const ctx = event.locals.auth;
	if (ctx) {
		await log({ type: 'login', subtype: 'logout', action: 'E', outcome: '0' }, actorFromContext(ctx));
	}
	await endSession(event.cookies);
	redirect(303, '/logg-inn');
};

export const GET: RequestHandler = async (event) => {
	await endSession(event.cookies);
	redirect(303, '/logg-inn');
};
