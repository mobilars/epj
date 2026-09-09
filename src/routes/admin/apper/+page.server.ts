import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listKlienter, registrerKlient, settKlientstatus, type Klientkategori } from '$srv/auth/klienter';
import { opprettLaunch } from '$srv/auth/oauth';
import { beskrivScope } from '$srv/authz/scopes';
import { logg, aktorFraKontekst } from '$srv/audit';
import { query } from '$srv/db';
import { config } from '$srv/config';

/**
 * Register over SMART-apper og backend-tjenester.
 *
 * Registrering er en administrativ handling: en app som ikke står her, kommer
 * ikke til journalen. Databehandleravtale registreres sammen med appen, slik at
 * samtykkedialogen kan varsle dersom den mangler.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.rettigheter.has('admin:apper')) error(403, 'Ingen tilgang.');

	const aktiveTokens = await query<{ client_id: string; n: number }>(
		"SELECT client_id, count(*)::int AS n FROM oauth_token WHERE kind = 'access' AND tilbakekalt = false AND utloper > now() GROUP BY client_id"
	);
	const tokenKart = new Map(aktiveTokens.map((t) => [t.client_id, t.n]));

	return {
		fhirBaseUrl: config.fhirBaseUrl,
		wellKnown: `${config.baseUrl}/.well-known/smart-configuration`,
		apper: (await listKlienter()).map((k) => ({
			clientId: k.client_id,
			navn: k.navn,
			type: k.type,
			kategori: k.klient_kategori,
			redirectUris: k.redirect_uris,
			scopes: k.tillatte_scopes.map((s) => ({ scope: s, beskrivelse: beskrivScope(s) })),
			grantTypes: k.grant_types,
			status: k.status,
			databehandleravtale: k.databehandleravtale,
			launchUrl: k.launch_url,
			harNokler: Boolean(k.jwks || k.jwks_uri),
			aktiveTokens: tokenKart.get(k.client_id) ?? 0,
			opprettet: new Date(k.opprettet).toLocaleDateString('nb-NO')
		}))
	};
};

export const actions: Actions = {
	registrer: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('admin:apper')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const navn = String(form.get('navn') ?? '').trim();
		const redirectUris = String(form.get('redirectUris') ?? '').split(/\s+/).filter(Boolean);
		const scopes = String(form.get('scopes') ?? '').split(/\s+/).filter(Boolean);
		const kategori = String(form.get('kategori') ?? 'smart-ehr') as Klientkategori;
		const type = String(form.get('type') ?? 'public') as 'public' | 'confidential';

		if (!navn) return fail(400, { feil: 'Appen må ha et navn.' });
		if (kategori !== 'backend' && redirectUris.length === 0) {
			return fail(400, { feil: 'SMART-apper må ha minst én redirect-URI.' });
		}

		let jwks: { keys: JsonWebKey[] } | undefined;
		const jwksTekst = String(form.get('jwks') ?? '').trim();
		if (jwksTekst) {
			try {
				jwks = JSON.parse(jwksTekst);
			} catch {
				return fail(400, { feil: 'JWKS er ikke gyldig JSON.' });
			}
		}
		if (kategori === 'backend' && !jwks && !String(form.get('jwksUri') ?? '').trim()) {
			return fail(400, { feil: 'Backend-tjenester må autentisere med private_key_jwt, og trenger JWKS eller jwks_uri.' });
		}

		const { klient, secret } = await registrerKlient({
			navn, type, kategori, redirectUris, scopes,
			jwks,
			jwksUri: String(form.get('jwksUri') ?? '').trim() || undefined,
			launchUrl: String(form.get('launchUrl') ?? '').trim() || undefined,
			databehandleravtale: String(form.get('databehandleravtale') ?? '').trim() || undefined,
			opprettetAv: ctx.userId ?? undefined
		});
		await logg(
			{ type: 'admin', subtype: 'app:registrert', handling: 'C', utfall: '0', entityRef: `Device/${klient.client_id}`, detaljer: { navn, kategori, scopes: scopes.join(' ') } },
			aktorFraKontekst(ctx)
		);
		return { ok: true, clientId: klient.client_id, secret };
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('admin:apper')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const status = String(form.get('status') ?? 'aktiv') as 'aktiv' | 'sperret';
		await settKlientstatus(clientId, status);
		await logg(
			{ type: 'admin', subtype: 'app:status', handling: 'U', utfall: '0', entityRef: `Device/${clientId}`, detaljer: { status } },
			aktorFraKontekst(ctx)
		);
		redirect(303, '/admin/apper');
	},

	/** Starter en app fra journalen (EHR launch), for å prøve integrasjonen. */
	testlaunch: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');
		const patientId = String(form.get('patientId') ?? '').trim() || null;
		const launchId = await opprettLaunch({ clientId, userId: ctx.userId, patientId });
		return {
			ok: true,
			launchUrl: `${config.baseUrl}/oauth/authorize?...&launch=${launchId}&aud=${encodeURIComponent(config.fhirBaseUrl)}`,
			launchId
		};
	}
};
