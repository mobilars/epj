import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listClients } from '$srv/auth/clients';
import { createLaunch } from '$srv/auth/oauth';
import { log, actorFromContext } from '$srv/audit';
import { fhirBaseFor, requireTenant } from '$srv/tenant/context';

/**
 * A SMART app started from the main menu, with no patient in context.
 *
 * This is for apps whose work spans patients - a laboratory worklist, a
 * message inbox, a quality dashboard. An app that only makes sense for one
 * patient belongs under the patient instead (see `/pasienter/[id]/apper`), and
 * the administration page says so where the choice is made.
 *
 * The launch carries the user and the organisation but no patient, so the app
 * receives `launch/practitioner` context only. Whether it may then look up
 * patients itself is a matter of its scopes and the user's role - the guard in
 * front of FHIR checks both on every request, exactly as it does for the
 * record's own pages.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.userId) redirect(303, '/logg-inn');

	const client = (await listClients()).find(
		(c) => c.client_id === event.params.klient && c.status === 'aktiv' && c.in_main_menu
	);
	if (!client) error(404, 'Ukjent app.');
	if (!client.launch_url) error(400, 'Appen har ingen launch-URL og kan ikke startes fra journalen.');

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
			details: { app: client.name, innrammet: true, pasientkontekst: false }
		},
		actorFromContext(ctx)
	);

	const url = new URL(client.launch_url);
	url.searchParams.set('iss', fhirBaseFor(requireTenant()));
	url.searchParams.set('launch', launchId);

	return { app: { name: client.name, clientId: client.client_id }, launchUrl: url.toString() };
};
