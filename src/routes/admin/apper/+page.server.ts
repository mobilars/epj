import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listClients, registerClient, setKlientstatus, type ClientCategory , setInMainMenu, setInPatientTabs, setLaunchMode, updateClient, setPlacement, setRequireConsent, type Placement } from '$srv/auth/clients';
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
 * Registration is an administrative act: an app not listed here does not reach
 * the record. The data processing agreement is recorded with the app, so the
 * consent dialog can warn if it is missing.
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

	return {
		fhirBaseUrl: fhirBaseFor(requireTenant()),
		issuerUrl: issuerFor(requireTenant()),
		wellKnown: `${issuerFor(requireTenant())}/.well-known/smart-configuration`,
		apper: (await listClients()).map((k) => ({
			clientId: k.client_id,
			name: k.name,
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
			jwksUri: k.jwks_uri ?? '',
			jwks: k.jwks ? JSON.stringify(k.jwks, null, 1) : '',
			logoUrl: k.logo_url ?? '',
			aktiveTokens: tokenKart.get(k.client_id) ?? 0,
			created_at: new Date(k.created_at).toLocaleDateString('nb-NO')
		}))
	};
};

export const actions: Actions = {
	register: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		// Handed back on failure so the form fills itself in again.
		const values = Object.fromEntries(
			['navn', 'kategori', 'type', 'redirectUris', 'scopes', 'launchUrl', 'jwks', 'jwksUri', 'logoUrl', 'databehandleravtale'].map(
				(f) => [f, String(form.get(f) ?? '')]
			)
		);
		const name = String(form.get('navn') ?? '').trim();
		const redirectUris = String(form.get('redirectUris') ?? '').split(/\s+/).filter(Boolean);
		const scopes = String(form.get('scopes') ?? '').split(/\s+/).filter(Boolean);
		const category = String(form.get('kategori') ?? 'smart-ehr') as ClientCategory;
		const type = String(form.get('type') ?? 'public') as 'public' | 'confidential';

		if (!name) return fail(400, { error: 'Appen må ha et navn.', values });
		if (category !== 'backend' && redirectUris.length === 0) {
			return fail(400, { error: 'SMART-apper må ha minst én redirect-URI.', values });
		}

		let jwks: { keys: JsonWebKey[] } | undefined;
		const jwksText = String(form.get('jwks') ?? '').trim();
		if (jwksText) {
			try {
				jwks = JSON.parse(jwksText);
			} catch {
				return fail(400, { error: 'JWKS er ikke gyldig JSON.', values });
			}
		}
		if (category === 'backend' && !jwks && !String(form.get('jwksUri') ?? '').trim()) {
			return fail(400, { error: 'Backend-tjenester må autentisere med private_key_jwt, og trenger JWKS eller jwks_uri.', values });
		}

		const { client, secret } = await registerClient({
			name, type, category, redirectUris, scopes,
			jwks,
			jwksUri: String(form.get('jwksUri') ?? '').trim() || undefined,
			launchUrl: String(form.get('launchUrl') ?? '').trim() || undefined,
			inMainMenu: form.get('iHovedmeny') === 'ja',
			databehandleravtale: String(form.get('databehandleravtale') ?? '').trim() || undefined,
			createdOf: ctx.userId ?? undefined
		});
		await log(
			{ type: 'admin', subtype: 'app:registrert', action: 'C', outcome: '0', entityRef: `Device/${client.client_id}`, details: { name, category, scopes: scopes.join(' ') } },
			actorFromContext(ctx)
		);
		return { ok: true, clientId: client.client_id, secret };
	},

	oppdater: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const existing = (await listClients()).find((c) => c.client_id === clientId);
		if (!existing) return fail(404, { error: 'Ukjent app.' });

		const name = String(form.get('navn') ?? '').trim();
		const redirectUris = String(form.get('redirectUris') ?? '').split(/\s+/).filter(Boolean);
		const scopes = String(form.get('scopes') ?? '').split(/\s+/).filter(Boolean);
		if (!name) return fail(400, { error: 'Appen må ha et navn.' });
		if (existing.client_category !== 'backend' && redirectUris.length === 0) {
			return fail(400, { error: 'SMART-apper må ha minst én redirect-URI.' });
		}
		// An exact address, https except on localhost, and no fragment.
		const badUri = redirectUris.find((u) => {
			try {
				const url = new URL(u);
				const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
				return (url.protocol !== 'https:' && !local) || Boolean(url.hash);
			} catch {
				return true;
			}
		});
		if (badUri) return fail(400, { error: `Ugyldig redirect-URI: ${badUri}` });

		let jwks: { keys: JsonWebKey[] } | undefined;
		const jwksText = String(form.get('jwks') ?? '').trim();
		if (jwksText) {
			try {
				jwks = JSON.parse(jwksText);
			} catch {
				return fail(400, { error: 'JWKS er ikke gyldig JSON.' });
			}
		}
		const jwksUri = String(form.get('jwksUri') ?? '').trim() || undefined;
		if (existing.client_category === 'backend' && !jwks && !jwksUri) {
			return fail(400, { error: 'Backend-tjenester trenger JWKS eller jwks_uri.' });
		}

		await updateClient(clientId, {
			name, redirectUris, scopes, jwks, jwksUri,
			launchUrl: String(form.get('launchUrl') ?? '').trim() || undefined,
			logoUrl: String(form.get('logoUrl') ?? '').trim() || undefined,
			databehandleravtale: String(form.get('databehandleravtale') ?? '').trim() || undefined
		});
		await log(
			{
				type: 'admin', subtype: 'app:endret', action: 'U', outcome: '0', entityRef: `Device/${clientId}`,
				details: {
					name, redirectUris: redirectUris.join(' '), scopes: scopes.join(' '),
					previousName: existing.name, previousRedirectUris: existing.redirect_uris.join(' '),
					previousScopes: existing.allowed_scopes.join(' ')
				}
			},
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
		await setKlientstatus(clientId, status);
		await log(
			{ type: 'admin', subtype: 'app:status', action: 'U', outcome: '0', entityRef: `Device/${clientId}`, details: { status } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/apper');
	},

	/** Launches an app from the record (EHR launch), to try the integration. */
	testlaunch: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) return fail(403, { error: 'Ingen tilgang.' });
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
