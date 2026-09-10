import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { completeLogin, endFlow } from '$srv/auth/helseid';
import { createSession } from '$srv/auth/session';
import { log } from '$srv/audit';

/** Callback from HelseID after authentication. */
export const GET: RequestHandler = async (event) => {
	const actor = {
		userId: null,
		actorRef: 'Person/ukjent',
		name: 'HelseID',
		role: null,
		clientId: null,
		ip: event.locals.clientIp,
		requestId: event.locals.requestId
	};

	const errorCode = event.url.searchParams.get('error');
	if (errorCode) {
		endFlow(event.cookies);
		await log({ type: 'login', subtype: 'helseid', action: 'E', outcome: '4', outcomeDescription: errorCode }, actor);
		redirect(303, `/logg-inn?feil=${encodeURIComponent('HelseID avbrøt påloggingen')}`);
	}

	if (!event.url.searchParams.get('code')) {
		endFlow(event.cookies);
		redirect(303, '/logg-inn?feil=Mangler%20kode%20fra%20HelseID');
	}

	const result = await completeLogin(event.cookies, event.url);
	if (!result.ok) {
		await log({ type: 'login', subtype: 'helseid', action: 'E', outcome: '4', outcomeDescription: result.error }, actor);
		redirect(303, `/logg-inn?feil=${encodeURIComponent(result.error)}`);
	}

	if (result.user.status !== 'aktiv') {
		await log({ type: 'login', subtype: 'helseid', action: 'E', outcome: '4', outcomeDescription: 'Kontoen er ikke aktiv' }, { ...actor, userId: result.user.id, name: result.user.name });
		redirect(303, '/logg-inn?feil=Kontoen%20er%20ikke%20aktiv');
	}

	await createSession(result.user.id, 'helseid', event.locals.clientIp, event.request.headers.get('user-agent'), event.cookies);
	await log(
		{
			type: 'login', subtype: 'helseid', action: 'E', outcome: '0',
			details: {
				hpr: result.claims.hprNumber,
				sikkerhetsniva: result.claims.securityLevel,
				newUser: result.newUser,
				roles: result.roles.join(',')
			}
		},
		{
			...actor,
			userId: result.user.id,
			actorRef: result.user.practitioner_id ? `Practitioner/${result.user.practitioner_id}` : `Person/${result.user.id}`,
			name: result.user.name,
			role: result.roles[0] ?? null
		}
	);

	// A new user without roles has no access until an administrator assigns one.
	redirect(303, result.roles.length === 0 ? '/ingen-tilgang' : result.returnTo);
};
