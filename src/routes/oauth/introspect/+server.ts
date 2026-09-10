import type { RequestHandler } from './$types';
import { authenticateClient } from '$srv/auth/clients';
import { introspiser } from '$srv/auth/tokens';

/** RFC 7662. Only authenticated clients may look up tokens. */
export const POST: RequestHandler = async (event) => {
	const form = new URLSearchParams(await event.request.text());
	const auth = await authenticateClient(form, event.request.headers.get('authorization'));
	if (!auth.ok || auth.method === 'none') {
		return new Response(JSON.stringify({ error: 'invalid_client' }), {
			status: 401,
			headers: { 'content-type': 'application/json' }
		});
	}
	const token = form.get('token');
	if (!token) return new Response(JSON.stringify({ active: false }), { headers: { 'content-type': 'application/json' } });
	return new Response(JSON.stringify(await introspiser(token)), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
};
