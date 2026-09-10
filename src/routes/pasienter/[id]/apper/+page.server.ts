import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listClients } from '$srv/auth/clients';
import { createLaunch } from '$srv/auth/oauth';
import { describeScope } from '$srv/authz/scopes';
import { config } from '$srv/config';
import { log, actorFromContext } from '$srv/audit';
import { fhirBaseFor, requireTenant } from '$srv/tenant/context';

/**
 * SMART apps launched from the record (EHR launch).
 *
 * The clinician picks an app, the record creates a short-lived launch context
 * with the patient, and sends the user to the app's launch URL with `iss` and
 * `launch`. The app fetches the configuration itself from
 * /.well-known/smart-configuration and starts the authorisation flow.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { apper: [] };

	return {
		apper: (await listClients())
			.filter((k) => k.status === 'aktiv' && k.client_category === 'smart-ehr' && k.launch_url)
			.map((k) => ({
				clientId: k.client_id,
				name: k.name,
				launchUrl: k.launch_url as string,
				databehandleravtale: k.databehandleravtale,
				scopes: k.allowed_scopes.filter((s) => s.includes('/')).map((s) => describeScope(s))
			}))
	};
};

export const actions: Actions = {
	start: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');

		const client = (await listClients()).find((k) => k.client_id === clientId && k.status === 'aktiv');
		if (!client?.launch_url) return fail(400, { error: 'Appen finnes ikke, eller mangler launch-URL.' });

		const launchId = await createLaunch({
			clientId,
			userId: ctx.userId,
			patientId: event.params.id,
			encounterId: String(form.get('encounterId') ?? '') || null
		});

		await log(
			{
				type: 'rest', subtype: 'smart:launch', action: 'E', outcome: '0',
				patientId: event.params.id, entityRef: `Device/${clientId}`,
				details: { app: client.name }
			},
			actorFromContext(ctx)
		);

		const url = new URL(client.launch_url);
		// `iss` is the organisation's own FHIR endpoint. The app fetches the
		// configuration from there, and sends it back as `aud` in the authorisation.
		url.searchParams.set('iss', fhirBaseFor(requireTenant()));
		url.searchParams.set('launch', launchId);
		return { ok: true, url: url.toString(), launchId, appName: client.name };
	}
};
