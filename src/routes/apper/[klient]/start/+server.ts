import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listClients } from '$srv/auth/clients';
import { createLaunch } from '$srv/auth/oauth';
import { log, actorFromContext } from '$srv/audit';
import { fhirBaseFor, requireTenant } from '$srv/tenant/context';

/**
 * Starts an app in its own window, without a patient in context.
 *
 * The counterpart to the patient route: same reason for minting the launch on
 * the press rather than in the link, same opaque handover to the app.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.userId) redirect(303, '/logg-inn');

	const client = (await listClients()).find(
		(c) => c.client_id === event.params.klient && c.status === 'aktiv'
	);
	if (!client) error(404, 'Ukjent app.');
	if (!client.launch_url) error(400, 'Appen har ingen launch-URL og kan ikke startes.');

	const launchId = await createLaunch({
		clientId: client.client_id,
		userId: ctx.userId,
		patientId: null,
		encounterId: null
	});

	await log(
		{
			type: 'rest',
			subtype: 'smart:launch',
			action: 'E',
			outcome: '0',
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
