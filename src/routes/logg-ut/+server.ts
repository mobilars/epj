import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { avsluttSesjon } from '$srv/auth/session';
import { logg } from '$srv/audit';
import { aktorFraKontekst } from '$srv/audit';

export const POST: RequestHandler = async (event) => {
	const ctx = event.locals.auth;
	if (ctx) {
		await logg({ type: 'login', subtype: 'logout', handling: 'E', utfall: '0' }, aktorFraKontekst(ctx));
	}
	await avsluttSesjon(event.cookies);
	redirect(303, '/logg-inn');
};

export const GET: RequestHandler = async (event) => {
	await avsluttSesjon(event.cookies);
	redirect(303, '/logg-inn');
};
