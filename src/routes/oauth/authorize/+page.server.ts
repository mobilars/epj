import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getClient } from '$srv/auth/clients';
import { errorRedirect, consumeLaunch, createAuthorisationCode, validateAuthorisationRequest } from '$srv/auth/oauth';
import { describeScope, narrowIn } from '$srv/authz/scopes';
import { scopesForRoles } from '$srv/authz/roles';
import { log } from '$srv/audit';
import { fhirClient } from '$srv/fhir/client';
import type { FhirResource } from '$srv/fhir/types';

/**
 * The authorisation endpoint with the consent dialog.
 *
 * The user must be signed in to the record. Then exactly what the app asks
 * access to is shown, translated into Norwegian, and which patient the access
 * concerns. What the user approves can never exceed what the role permits.
 */

function pasientnavn(p: FhirResource | null): string | null {
	if (!p) return null;
	const name = (p.name as { given?: string[]; family?: string }[] | undefined)?.[0];
	if (!name) return null;
	return [name.given?.join(' '), name.family].filter(Boolean).join(' ');
}

export const load: PageServerLoad = async (event) => {
	const search = event.url.searchParams;
	const client = search.get('client_id') ? await getClient(search.get('client_id') as string) : null;
	const validation = validateAuthorisationRequest(search, client);

	if (!validation.ok) {
		await log(
			{ type: 'login', subtype: 'authorize', action: 'E', outcome: '4', outcomeDescription: validation.description, details: { client_id: search.get('client_id') } },
			{ userId: event.locals.auth?.userId ?? null, actorRef: 'Device/oauth', name: 'autorisasjonsendepunkt', role: null, clientId: search.get('client_id'), ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
		if (validation.canRedirect && validation.redirectUri) {
			redirect(303, errorRedirect(validation.redirectUri, validation.error, validation.description, validation.state));
		}
		error(400, { message: `${validation.error}: ${validation.description}`, code: validation.error });
	}

	// Requires a signed-in user in the record.
	if (!event.locals.auth || event.locals.auth.mate !== 'session') {
		const returnTo = `${event.url.pathname}${event.url.search}`;
		redirect(303, `/logg-inn?retur=${encodeURIComponent(returnTo)}`);
	}
	const ctx = event.locals.auth;

	// Launch context from the record (EHR launch).
	let launch = { patientId: null as string | null, encounterId: null as string | null, intent: null as string | null };
	if (validation.request.launch) {
		const forbrukt = await consumeLaunch(validation.request.launch, validation.client.client_id, ctx.userId as string);
		if (!forbrukt) {
			redirect(303, errorRedirect(validation.request.redirect_uri, 'invalid_request', 'Ugyldig eller utløpt launch-kontekst', validation.request.state));
		}
		launch = { patientId: forbrukt.patientId ?? null, encounterId: forbrukt.encounterId ?? null, intent: forbrukt.intent ?? null };
	}

	// Standalone launch where the app asks for patient context without an EHR
	// launch: the patient is chosen by the user in the next step.
	const scopeList = validation.request.scope.split(/\s+/).filter(Boolean);
	const innsnevret = narrowIn(validation.request.scope, validation.client.allowed_scopes, scopesForRoles(ctx.roles));
	const rejected = scopeList.filter((s) => !innsnevret.split(/\s+/).includes(s));

	let patient: FhirResource | null = null;
	if (launch.patientId) {
		patient = await fhirClient.read('Patient', launch.patientId, { requestId: event.locals.requestId }).catch(() => null);
	}

	return {
		client: {
			name: validation.client.name,
			clientId: validation.client.client_id,
			logoUrl: validation.client.logo_url,
			category: validation.client.client_category,
			databehandleravtale: validation.client.databehandleravtale
		},
		user: { name: ctx.name, roles: ctx.roles },
		scopes: innsnevret.split(/\s+/).filter(Boolean).map((s) => ({ scope: s, description: describeScope(s) })),
		avvisteScopes: rejected.map((s) => ({ scope: s, description: describeScope(s) })),
		innsnevret,
		launch: {
			patientId: launch.patientId,
			encounterId: launch.encounterId,
			patientName: pasientnavn(patient)
		},
		request: {
			redirect_uri: validation.request.redirect_uri,
			state: validation.request.state,
			code_challenge: validation.request.code_challenge,
			code_challenge_method: validation.request.code_challenge_method,
			nonce: validation.request.nonce ?? null,
			client_id: validation.client.client_id
		}
	};
};

export const actions: Actions = {
	godkjenn: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx || ctx.mate !== 'session' || !ctx.userId) error(401, 'Ikke innlogget');

		const form = await event.request.formData();
		const clientId = String(form.get('client_id') ?? '');
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const state = String(form.get('state') ?? '');
		const scope = String(form.get('scope') ?? '');
		const codeChallenge = String(form.get('code_challenge') ?? '');
		const codeChallengeMethod = String(form.get('code_challenge_method') ?? 'S256');
		const nonce = form.get('nonce') ? String(form.get('nonce')) : null;
		const patientId = form.get('patient_id') ? String(form.get('patient_id')) : null;
		const encounterId = form.get('encounter_id') ? String(form.get('encounter_id')) : null;

		const client = await getClient(clientId);
		if (!client || !client.redirect_uris.includes(redirectUri)) {
			return fail(400, { error: 'Ugyldig klient eller redirect_uri' });
		}

		// Narrowed again server-side: the form is not to be trusted.
		const allowed = narrowIn(scope, client.allowed_scopes, scopesForRoles(ctx.roles));
		if (!allowed) return fail(400, { error: 'Ingen av de forespurte tilgangene er tillatt for din rolle' });

		const code = await createAuthorisationCode({
			clientId,
			userId: ctx.userId,
			redirectUri,
			scope: allowed,
			codeChallenge,
			codeChallengeMethod,
			nonce,
			launch: { patientId, encounterId }
		});

		await log(
			{ type: 'login', subtype: 'authorize', action: 'E', outcome: '0', patientId, details: { client_id: clientId, scope: allowed } },
			{ userId: ctx.userId, actorRef: ctx.actorRef, name: ctx.name, role: ctx.roles[0] ?? null, clientId, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);

		const url = new URL(redirectUri);
		url.searchParams.set('code', code);
		url.searchParams.set('state', state);
		redirect(303, url.toString());
	},

	avslaa: async (event) => {
		const form = await event.request.formData();
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const state = String(form.get('state') ?? '');
		const clientId = String(form.get('client_id') ?? '');
		const client = await getClient(clientId);
		if (!client || !client.redirect_uris.includes(redirectUri)) error(400, 'Ugyldig redirect_uri');
		await log(
			{ type: 'login', subtype: 'authorize', action: 'E', outcome: '4', outcomeDescription: 'Brukeren avslo tilgang', details: { client_id: clientId } },
			{ userId: event.locals.auth?.userId ?? null, actorRef: event.locals.auth?.actorRef ?? 'Device/oauth', name: event.locals.auth?.name ?? 'ukjent', role: null, clientId, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
		redirect(303, errorRedirect(redirectUri, 'access_denied', 'Brukeren avslo tilgang', state));
	}
};
