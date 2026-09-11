import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listClients } from '$srv/auth/clients';
import { createLaunch } from '$srv/auth/oauth';
import { log, actorFromContext } from '$srv/audit';
import { fhirBaseFor, requireTenant } from '$srv/tenant/context';

/**
 * Starts an app in its own window, with the patient in context.
 *
 * The launch is minted here rather than put in the link, because a link is
 * pressed whenever the user gets round to it: a launch context is short-lived
 * and single-use, so one baked into the page would be spent or stale by then.
 * Going through the record first costs one redirect and means the window always
 * opens on a launch made for that press.
 *
 * The app still authorises for itself. What leaves here is the opaque `launch`
 * and the `iss` to resolve it against - no session, no token, no patient.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.userId) redirect(303, '/logg-inn');

	const client = (await listClients()).find(
		(c) => c.client_id === event.params.klient && c.status === 'aktiv'
	);
	if (!client) error(404, 'Ukjent app.');
	if (!client.launch_url) error(400, 'Appen har ingen launch-URL og kan ikke startes fra journalen.');

	const launchId = await createLaunch({
		clientId: client.client_id,
		userId: ctx.userId,
		patientId: event.params.id,
		encounterId: null
	});

	await log(
		{
			type: 'rest',
			subtype: 'smart:launch',
			action: 'E',
			outcome: '0',
			patientId: event.params.id,
			entityRef: `Device/${client.client_id}`,
			details: { app: client.name, innrammet: false }
		},
		actorFromContext(ctx)
	);

	const url = new URL(client.launch_url);
	url.searchParams.set('iss', fhirBaseFor(requireTenant()));
	url.searchParams.set('launch', launchId);
	redirect(303, url.toString());
};
