import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { deleteClient, listClients, setDatabehandleravtale, setKlientstatus, setInMainMenu, setInPatientTabs, setLaunchMode, setPlacement, setRequireConsent, type Placement } from '$srv/auth/clients';
import { installsForTenant, mayBeActivated, mayBeDeleted, unapprovedClients } from '$srv/developer/catalogue';
import { isLaunchMode, launchModeOf } from '$srv/auth/launchmode';
import { createLaunch } from '$srv/auth/oauth';
import { describeScope } from '$srv/authz/scopes';
import { log, actorFromContext } from '$srv/audit';
import { query } from '$srv/db';
import { config } from '$srv/config';
import { fhirBaseFor, requireTenant, issuerFor } from '$srv/tenant/context';

/**
 * Register of SMART apps and backend services.
 *
 * An app reaches this list by being installed from the gallery: developers
 * register apps in the developer portal, and the platform owner approves them. A
 * practice decides where an installed app appears and whether it may run, but not
 * what it may do, since its addresses and scopes are what was reviewed. The data
 * processing agreement is the practice's own, recorded with the app so the consent
 * dialog can warn if it is missing.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('admin:apper')) error(403, 'Ingen tilgang.');

	const aktiveTokens = await query<{ client_id: string; n: number }>(
		`SELECT client_id, count(*)::int AS n FROM oauth_token
		 WHERE tenant_id = $1 AND kind = 'access' AND revoked = false AND expires_at > now()
		 GROUP BY client_id`,
		[requireTenant().id]
	);
	const tokenKart = new Map(aktiveTokens.map((t) => [t.client_id, t.n]));
	const unapproved = await unapprovedClients();
	const installed = new Set((await installsForTenant()).map((install) => install.client_id));

	return {
		fhirBaseUrl: fhirBaseFor(requireTenant()),
		issuerUrl: issuerFor(requireTenant()),
		wellKnown: `${issuerFor(requireTenant())}/.well-known/smart-configuration`,
		apper: (await listClients()).map((k) => ({
			clientId: k.client_id,
			name: k.name,
			approved: !unapproved.has(k.client_id),
			// Added by the practice itself, or removed from it: its own to clean up.
			deletable: !installed.has(k.client_id),
			type: k.type,
			category: k.client_category,
			redirectUris: k.redirect_uris,
			scopes: k.allowed_scopes.map((s) => ({ scope: s, description: describeScope(s) })),
			grantTypes: k.grant_types,
			status: k.status,
			databehandleravtale: k.databehandleravtale,
			launchUrl: k.launch_url,
			inMainMenu: k.in_main_menu,
			inPatientTabs: k.in_patient_tabs,
			launchMode: launchModeOf(k),
			placement: k.placement,
			requireConsent: k.require_consent,
			hasKeys: Boolean(k.jwks || k.jwks_uri),
			aktiveTokens: tokenKart.get(k.client_id) ?? 0,
			created_at: new Date(k.created_at).toLocaleDateString('nb-NO')
		}))
	};
};

export const actions: Actions = {
	databehandleravtale: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const value = String(form.get('databehandleravtale') ?? '').trim() || null;
		await setDatabehandleravtale(clientId, value);
		await log(
			{ type: 'admin', subtype: 'app:endret', action: 'U', outcome: '0', entityRef: `Device/${clientId}`, details: { databehandleravtale: value } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/apper');
	},

	/**
	 * Where the app appears, saved in one go.
	 *
	 * These four settings answer one question between them, and splitting them
	 * across four one-button forms made each button a command whose label had to
	 * describe the opposite of the current state - press "Eget vindu" and you
	 * turned it off. Checkboxes say what is on, and one save applies the lot.
	 */
	visning: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const placement = String(form.get('plassering') ?? 'ingen') as Placement;
		if (!['ingen', 'hoved', 'side'].includes(placement)) return fail(400, { error: 'Ukjent plassering.' });
		const inPatientTabs = form.get('iPasientfaner') === 'ja';
		const inMainMenu = form.get('iHovedmeny') === 'ja';
		const modeValue = form.get('visningsmaate');
		if (!isLaunchMode(modeValue)) return fail(400, { error: 'Ukjent visningsmåte.' });

		await setPlacement(clientId, placement);
		await setInPatientTabs(clientId, inPatientTabs);
		await setInMainMenu(clientId, inMainMenu);
		await setLaunchMode(clientId, modeValue);
		await log(
			{
				type: 'admin', subtype: 'app:visning', action: 'U', outcome: '0', entityRef: `Device/${clientId}`,
				details: { placement, inPatientTabs, inMainMenu, launchMode: modeValue }
			},
			actorFromContext(ctx)
		);
		redirect(303, '/admin/apper');
	},

	samtykke: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const requireConsent = form.get('krevSamtykke') === 'ja';
		if (!requireConsent && (await unapprovedClients()).has(clientId)) {
			return fail(400, { error: 'En app som ikke er godkjent av plattformeier, må godkjennes av hver bruker.' });
		}
		await setRequireConsent(clientId, requireConsent);
		await log(
			{ type: 'admin', subtype: 'app:samtykke', action: 'U', outcome: '0', entityRef: `Device/${clientId}`, details: { requireConsent } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/apper');
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const status = String(form.get('status') ?? 'aktiv') as 'aktiv' | 'sperret';
		if (status === 'aktiv' && !(await mayBeActivated(clientId))) {
			return fail(400, { error: 'Appen kan ikke aktiveres igjen. Installer den fra appgalleriet hvis den er tilgjengelig der.' });
		}
		await setKlientstatus(clientId, status);
		await log(
			{ type: 'admin', subtype: 'app:status', action: 'U', outcome: '0', entityRef: `Device/${clientId}`, details: { status } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/apper');
	},

	slett: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const client = (await listClients()).find((c) => c.client_id === clientId);
		if (!client) return fail(404, { error: 'Ukjent app.' });
		if (!(await mayBeDeleted(clientId))) {
			return fail(400, { error: 'Appen er installert fra appgalleriet. Fjern den der først.' });
		}
		// Logged first, with the name: this is what makes the log readable afterwards.
		await log(
			{ type: 'admin', subtype: 'app:slettet', action: 'D', outcome: '0', entityRef: `Device/${clientId}`, details: { name: client.name } },
			actorFromContext(ctx)
		);
		await deleteClient(clientId);
		redirect(303, '/admin/apper');
	},

	/** Launches an app from the record (EHR launch), to try the integration. */
	testlaunch: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId || !ctx.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const patientId = String(form.get('patientId') ?? '').trim() || null;
		const launchId = await createLaunch({ clientId, userId: ctx.userId, patientId });
		return {
			ok: true,
			launchUrl: `${issuerFor(requireTenant())}/oauth/authorize?...&launch=${launchId}&aud=${encodeURIComponent(fhirBaseFor(requireTenant()))}`,
			launchId
		};
	}
};
