import type { RequestHandler } from './$types';
import { authenticateClient } from '$srv/auth/clients';
import { revokeToken } from '$srv/auth/tokens';
import { log } from '$srv/audit';

/** RFC 7009. Always answers 200, unknown tokens included. */
export const POST: RequestHandler = async (event) => {
	const form = new URLSearchParams(await event.request.text());
	const auth = await authenticateClient(form, event.request.headers.get('authorization'));
	if (!auth.ok) {
		return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401, headers: { 'content-type': 'application/json' } });
	}
	const token = form.get('token');
	if (token) {
		const truffet = await revokeToken(token, auth.client.client_id);
		await log(
			{ type: 'login', subtype: 'revoke', action: 'D', outcome: '0', details: { truffet } },
			{ userId: null, actorRef: 'Device/oauth', name: auth.client.name, role: null, clientId: auth.client.client_id, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
	}
	return new Response(null, { status: 200 });
};
