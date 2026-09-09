import type { RequestHandler } from './$types';
import { autentiserKlient } from '$srv/auth/klienter';
import { bytteInnKode } from '$srv/auth/oauth';
import { fornyMedRefreshToken, utstedTokens } from '$srv/auth/tokens';
import { snevreInn } from '$srv/authz/scopes';
import { logg } from '$srv/audit';

/**
 * Token-endepunktet (OAuth 2.1 / SMART App Launch).
 *
 * Støtter `authorization_code` (SMART-apper), `refresh_token` med rotasjon, og
 * `client_credentials` for SMART Backend Services. Alle utfall - også de
 * mislykkede - skrives til sikkerhetsloggen.
 */

function feil(kode: string, beskrivelse: string, status = 400): Response {
	return new Response(JSON.stringify({ error: kode, error_description: beskrivelse }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' }
	});
}

function ok(kropp: unknown): Response {
	return new Response(JSON.stringify(kropp), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' }
	});
}

export const POST: RequestHandler = async (event) => {
	const form = new URLSearchParams(await event.request.text());
	const aktor = {
		userId: null,
		actorRef: 'Device/oauth',
		navn: form.get('client_id') ?? 'ukjent klient',
		rolle: null,
		clientId: form.get('client_id'),
		ip: event.locals.clientIp,
		requestId: event.locals.requestId
	};

	const auth = await autentiserKlient(form, event.request.headers.get('authorization'));
	if (!auth.ok) {
		await logg({ type: 'login', subtype: 'token', handling: 'E', utfall: '4', utfallBeskrivelse: auth.feil }, aktor);
		return feil('invalid_client', auth.feil, 401);
	}
	const klient = auth.klient;
	aktor.navn = klient.navn;
	aktor.clientId = klient.client_id;

	const grantType = form.get('grant_type') ?? '';
	if (!klient.grant_types.includes(grantType)) {
		await logg({ type: 'login', subtype: 'token', handling: 'E', utfall: '4', utfallBeskrivelse: `grant_type ${grantType} ikke tillatt` }, aktor);
		return feil('unauthorized_client', `Klienten kan ikke bruke grant_type=${grantType}`);
	}

	switch (grantType) {
		case 'authorization_code': {
			const kode = form.get('code');
			const redirectUri = form.get('redirect_uri');
			if (!kode || !redirectUri) return feil('invalid_request', 'code og redirect_uri er påkrevd');
			const resultat = await bytteInnKode(kode, klient, redirectUri, form.get('code_verifier'));
			if (!resultat.ok) {
				await logg({ type: 'login', subtype: 'token', handling: 'E', utfall: '4', utfallBeskrivelse: resultat.beskrivelse }, aktor);
				return feil(resultat.feil, resultat.beskrivelse);
			}
			await logg({ type: 'login', subtype: 'token', handling: 'E', utfall: '0', patientId: resultat.tokens.patient ?? null, detaljer: { grant: 'authorization_code', scope: resultat.tokens.scope } }, aktor);
			return ok(resultat.tokens);
		}

		case 'refresh_token': {
			const rt = form.get('refresh_token');
			if (!rt) return feil('invalid_request', 'refresh_token er påkrevd');
			const resultat = await fornyMedRefreshToken(rt, klient.client_id, form.get('scope') ?? undefined);
			if (!resultat.ok) {
				await logg({ type: 'login', subtype: 'refresh', handling: 'E', utfall: '4', utfallBeskrivelse: resultat.feil }, aktor);
				return feil('invalid_grant', resultat.feil ?? 'Ugyldig refresh token');
			}
			await logg({ type: 'login', subtype: 'refresh', handling: 'E', utfall: '0' }, aktor);
			return ok(resultat.tokens);
		}

		case 'client_credentials': {
			// SMART Backend Services. Krever asymmetrisk klientautentisering, og
			// kan bare få `system/`-scopes - aldri pasientkontekst.
			if (auth.metode !== 'private_key_jwt') {
				return feil('invalid_client', 'Backend-tjenester må autentisere med private_key_jwt');
			}
			const forespurt = form.get('scope') ?? '';
			const innsnevret = snevreInn(forespurt, klient.tillatte_scopes, new Set(klient.tillatte_scopes));
			const kunSystem = innsnevret
				.split(/\s+/)
				.filter((s) => s.startsWith('system/'))
				.join(' ');
			if (!kunSystem) {
				await logg({ type: 'login', subtype: 'client-credentials', handling: 'E', utfall: '4', utfallBeskrivelse: 'ingen gyldige system-scopes' }, aktor);
				return feil('invalid_scope', 'Ingen av de forespurte scopene er tillatt for denne klienten');
			}
			const tokens = await utstedTokens({ clientId: klient.client_id, userId: null, scope: kunSystem, launch: {}, medRefresh: false });
			await logg({ type: 'login', subtype: 'client-credentials', handling: 'E', utfall: '0', detaljer: { scope: kunSystem } }, aktor);
			return ok({ access_token: tokens.access_token, token_type: 'Bearer', expires_in: tokens.expires_in, scope: kunSystem });
		}

		default:
			return feil('unsupported_grant_type', `grant_type «${grantType}» støttes ikke`);
	}
};
