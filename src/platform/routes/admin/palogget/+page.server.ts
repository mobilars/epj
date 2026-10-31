import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext, log } from '$srv/audit';
import { describeDevice, describeMethod, endSessionById, listActiveSessions } from '$srv/auth/activesessions';
import { formatsDate } from '$srv/fhir/display';

/**
 * Who is signed in to the practice right now, and a way to sign someone out.
 *
 * For the person responsible for the system: a PC left signed in at the
 * reception, an account in use from a device nobody recognises, a former
 * employee whose session outlived their contract by an afternoon. Ending a
 * session takes effect on that user's next request.
 *
 * It shows sessions, not people: someone signed in on two machines is listed
 * twice, because those are two ways into the record and each can be ended.
 */

const allowed = (permissions: Set<string>) => permissions.has('admin:brukere') || permissions.has('admin:system');

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, '/logg-inn');
	if (!allowed(ctx.permissions as Set<string>)) error(403, 'Ingen tilgang.');

	const now = Date.now();
	const sessions = await listActiveSessions();
	return {
		sessions: sessions.map((s) => {
			const idleMinutes = Math.floor((now - new Date(s.last_active).getTime()) / 60000);
			return {
				id: s.id,
				name: s.name,
				username: s.username,
				since: formatsDate(s.created_at, true),
				lastActive: formatsDate(s.last_active, true),
				idleMinutes,
				method: describeMethod(s.amr),
				device: describeDevice(s.user_agent),
				ip: s.ip,
				// Stepped up for emergency access and still inside that window.
				elevated: Boolean(s.elevated_until && new Date(s.elevated_until).getTime() > now),
				current: s.id === ctx.sessionId
			};
		}),
		people: new Set(sessions.map((s) => s.user_id)).size
	};
};

export const actions: Actions = {
	end: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!allowed(ctx.permissions as Set<string>)) return fail(403, { error: 'Ingen tilgang.' });

		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		// Your own session is ended by signing out, which also clears the cookie.
		if (id === ctx.sessionId) return fail(400, { error: 'Bruk «Logg ut» for å avslutte din egen økt.' });

		const ended = await endSessionById(id);
		if (!ended) return fail(404, { error: 'Økten er allerede avsluttet.' });

		// Whose session it was comes from the database, not from the form, so
		// the log says what actually happened.
		await log(
			{
				type: 'admin',
				subtype: 'økt:avsluttet',
				action: 'U',
				outcome: '0',
				entityRef: `Person/${ended.userId}`,
				entityName: ended.name,
				details: { session: id }
			},
			actorFromContext(ctx)
		);
		return { endedFor: ended.name };
	}
};
