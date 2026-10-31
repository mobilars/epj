import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from '$routetypes/sfm/oppfrisk/$types';
import { config } from '$srv/config';
import { refreshSfm } from '$apps/sfm/server/session-gateway';

/**
 * Keeps SFM's session alive while its frame is open. The page calls this on a
 * timer. SFM is only called when the token actually changed.
 */
export const POST: RequestHandler = async (event) => {
	if (!config.integrations.sfm.full) error(404, 'Ikke tilgjengelig');
	const ctx = event.locals.auth;
	if (!ctx?.sessionId || ctx.mate !== 'session') error(401, 'Ikke innlogget');
	if (event.request.headers.get('origin') !== event.url.origin) error(403, 'Kryssopphavs-kall avvist');

	try {
		return (await refreshSfm(ctx.sessionId)) ? json({ ok: true }) : json({ ok: false }, { status: 409 });
	} catch (err) {
		console.error('[sfm] could not refresh', (err as Error).message);
		return json({ ok: false }, { status: 502 });
	}
};
