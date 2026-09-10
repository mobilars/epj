import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listClients } from '$srv/auth/clients';
import { createLaunch } from '$srv/auth/oauth';
import { log, actorFromContext } from '$srv/audit';
import { fhirBaseFor, requireTenant } from '$srv/tenant/context';

/**
 * A SMART app running inside the record.
 *
 * The app is framed rather than opened elsewhere, so the patient banner, the
 * tabs and the quick-task panel stay where they are. Leaving the record to use
 * an app - and having to find your way back to the same patient afterwards -
 * is what makes an app feel bolted on rather than part of the consultation.
 *
 * The launch context is minted per visit and is short-lived and single-use, so
 * reloading this page starts a fresh launch rather than replaying an old one.
 * The app still authorises for itself: the frame carries no session, no token
 * and no patient - only the opaque `launch` value and the `iss` to resolve it
 * against, exactly as an app opened any other way would receive.
 */
export const load: PageServerLoad = async (event) => {
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
			details: { app: client.name, innrammet: true }
		},
		actorFromContext(ctx)
	);

	const url = new URL(client.launch_url);
	url.searchParams.set('iss', fhirBaseFor(requireTenant()));
	url.searchParams.set('launch', launchId);

	return {
		app: { name: client.name, clientId: client.client_id },
		launchUrl: url.toString(),
		patientId: event.params.id
	};
};
