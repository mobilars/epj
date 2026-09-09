import type { RequestHandler } from './$types';
import { autentiserKlient } from '$srv/auth/klienter';
import { tilbakekallToken } from '$srv/auth/tokens';
import { logg } from '$srv/audit';

/** RFC 7009. Svarer alltid 200, også for ukjente tokens. */
export const POST: RequestHandler = async (event) => {
	const form = new URLSearchParams(await event.request.text());
	const auth = await autentiserKlient(form, event.request.headers.get('authorization'));
	if (!auth.ok) {
		return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401, headers: { 'content-type': 'application/json' } });
	}
	const token = form.get('token');
	if (token) {
		const truffet = await tilbakekallToken(token, auth.klient.client_id);
		await logg(
			{ type: 'login', subtype: 'revoke', handling: 'D', utfall: '0', detaljer: { truffet } },
			{ userId: null, actorRef: 'Device/oauth', navn: auth.klient.navn, rolle: null, clientId: auth.klient.client_id, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
	}
	return new Response(null, { status: 200 });
};
