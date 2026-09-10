import type { RequestHandler } from './$types';
import { authenticateClient } from '$srv/auth/clients';
import { exchangeInCode } from '$srv/auth/oauth';
import { renewWithRefreshToken, issueTokens } from '$srv/auth/tokens';
import { narrowIn } from '$srv/authz/scopes';
import { log } from '$srv/audit';

/**
 * Token-endepunktet (OAuth 2.1 / SMART App Launch).
 *
 * Støtter `authorization_code` (SMART-apper), `refresh_token` med rotasjon, og
 * `client_credentials` for SMART Backend Services. Alle utfall - også de
 * mislykkede - skrives til sikkerhetsloggen.
 */

function error(code: string, description: string, status = 400): Response {
	return new Response(JSON.stringify({ error: code, error_description: description }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' }
	});
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' }
	});
}

export const POST: RequestHandler = async (event) => {
	const form = new URLSearchParams(await event.request.text());
	const actor = {
		userId: null,
		actorRef: 'Device/oauth',
		name: form.get('client_id') ?? 'ukjent klient',
		role: null,
		clientId: form.get('client_id'),
		ip: event.locals.clientIp,
		requestId: event.locals.requestId
	};

	const auth = await authenticateClient(form, event.request.headers.get('authorization'));
	if (!auth.ok) {
		await log({ type: 'login', subtype: 'token', action: 'E', outcome: '4', outcomeDescription: auth.error }, actor);
		return error('invalid_client', auth.error, 401);
	}
	const client = auth.client;
	actor.name = client.name;
	actor.clientId = client.client_id;

	const grantType = form.get('grant_type') ?? '';
	if (!client.grant_types.includes(grantType)) {
		await log({ type: 'login', subtype: 'token', action: 'E', outcome: '4', outcomeDescription: `grant_type ${grantType} ikke tillatt` }, actor);
		return error('unauthorized_client', `Klienten kan ikke bruke grant_type=${grantType}`);
	}

	switch (grantType) {
		case 'authorization_code': {
			const code = form.get('code');
			const redirectUri = form.get('redirect_uri');
			if (!code || !redirectUri) return error('invalid_request', 'code og redirect_uri er påkrevd');
			const result = await exchangeInCode(code, client, redirectUri, form.get('code_verifier'));
			if (!result.ok) {
				await log({ type: 'login', subtype: 'token', action: 'E', outcome: '4', outcomeDescription: result.description }, actor);
				return error(result.error, result.description);
			}
			await log({ type: 'login', subtype: 'token', action: 'E', outcome: '0', patientId: result.tokens.patient ?? null, details: { grant: 'authorization_code', scope: result.tokens.scope } }, actor);
			return ok(result.tokens);
		}

		case 'refresh_token': {
			const rt = form.get('refresh_token');
			if (!rt) return error('invalid_request', 'refresh_token er påkrevd');
			const result = await renewWithRefreshToken(rt, client.client_id, form.get('scope') ?? undefined);
			if (!result.ok) {
				await log({ type: 'login', subtype: 'refresh', action: 'E', outcome: '4', outcomeDescription: result.error }, actor);
				return error('invalid_grant', result.error ?? 'Ugyldig refresh token');
			}
			await log({ type: 'login', subtype: 'refresh', action: 'E', outcome: '0' }, actor);
			return ok(result.tokens);
		}

		case 'client_credentials': {
			// SMART Backend Services. Krever asymmetrisk klientautentisering, og
			// kan bare få `system/`-scopes - aldri pasientkontekst.
			if (auth.method !== 'private_key_jwt') {
				return error('invalid_client', 'Backend-tjenester må autentisere med private_key_jwt');
			}
			const forespurt = form.get('scope') ?? '';
			const innsnevret = narrowIn(forespurt, client.allowed_scopes, new Set(client.allowed_scopes));
			const onlySystem = innsnevret
				.split(/\s+/)
				.filter((s) => s.startsWith('system/'))
				.join(' ');
			if (!onlySystem) {
				await log({ type: 'login', subtype: 'client-credentials', action: 'E', outcome: '4', outcomeDescription: 'ingen gyldige system-scopes' }, actor);
				return error('invalid_scope', 'Ingen av de forespurte scopene er tillatt for denne klienten');
			}
			const tokens = await issueTokens({ clientId: client.client_id, userId: null, scope: onlySystem, launch: {}, withRefresh: false });
			await log({ type: 'login', subtype: 'client-credentials', action: 'E', outcome: '0', details: { scope: onlySystem } }, actor);
			return ok({ access_token: tokens.access_token, token_type: 'Bearer', expires_in: tokens.expires_in, scope: onlySystem });
		}

		default:
			return error('unsupported_grant_type', `grant_type «${grantType}» støttes ikke`);
	}
};
