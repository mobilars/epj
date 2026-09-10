import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { endFlow, fullforLogin } from '$srv/auth/helseid';
import { createSession } from '$srv/auth/session';
import { log } from '$srv/audit';

/** Tilbakekall fra HelseID etter autentisering. */
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

	const code = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	if (!code || !state) redirect(303, '/logg-inn?feil=Mangler%20kode%20fra%20HelseID');

	const result = await fullforLogin(event.cookies, code, state);
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
				hpr: result.requirement.hprNumber,
				sikkerhetsniva: result.requirement.sikkerhetsniva,
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

	// Ny bruker uten roller har ingen tilgang før systemansvarlig har tildelt rolle.
	redirect(303, result.roles.length === 0 ? '/ingen-tilgang' : result.returnTo);
};
