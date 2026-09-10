import type { RequestHandler } from './$types';
import { authenticateClient } from '$srv/auth/clients';
import { exchangeInCode } from '$srv/auth/oauth';
import { renewWithRefreshToken, issueTokens } from '$srv/auth/tokens';
import { narrowIn } from '$srv/authz/scopes';
import { log } from '$srv/audit';
import { allowedOpphav } from '$srv/auth/cors';
import { corsHeadere } from '$srv/http';

/**
 * The token endpoint (OAuth 2.1 / SMART App Launch).
 *
 * Supports `authorization_code` (SMART apps), `refresh_token` with rotation,
 * and `client_credentials` for SMART Backend Services. Every outcome - the
 * failed ones included - is written to the security log.
 */

/**
 * A public client runs in the browser, so its token exchange is a cross-origin
 * request like any other. The origins are the registered apps' own, and no
 * others - a public client has no secret, and the redirect URI plus PKCE are
 * what protect the exchange, not the absence of this header.
 */
type Cors = Record<string, string>;

function error(code: string, description: string, status = 400, cors: Cors = {}): Response {
	return new Response(JSON.stringify({ error: code, error_description: description }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...cors }
	});
}

function ok(body: unknown, cors: Cors = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...cors }
	});
}

/** Preflight, for clients that send one before the form post. */
export const OPTIONS: RequestHandler = async (event) =>
	new Response(null, {
		status: 204,
		headers: {
			...corsHeadere(event.request.headers.get('origin'), await allowedOpphav()),
			'access-control-allow-methods': 'POST, OPTIONS',
			'access-control-allow-headers': 'content-type, authorization',
			'access-control-max-age': '600'
		}
	});

export const POST: RequestHandler = async (event) => {
	// Per request, never shared: two token exchanges from different apps can be
	// in flight at once, and each must get its own origin back.
	const cors = corsHeadere(event.request.headers.get('origin'), await allowedOpphav());
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
		return error('invalid_client', auth.error, 401, cors);
	}
	const client = auth.client;
	actor.name = client.name;
	actor.clientId = client.client_id;

	const grantType = form.get('grant_type') ?? '';
	if (!client.grant_types.includes(grantType)) {
		await log({ type: 'login', subtype: 'token', action: 'E', outcome: '4', outcomeDescription: `grant_type ${grantType} ikke tillatt` }, actor);
		return error('unauthorized_client', `Klienten kan ikke bruke grant_type=${grantType}`, undefined, cors);
	}

	switch (grantType) {
		case 'authorization_code': {
			const code = form.get('code');
			const redirectUri = form.get('redirect_uri');
			if (!code || !redirectUri) return error('invalid_request', 'code og redirect_uri er påkrevd', undefined, cors);
			const result = await exchangeInCode(code, client, redirectUri, form.get('code_verifier'));
			if (!result.ok) {
				await log({ type: 'login', subtype: 'token', action: 'E', outcome: '4', outcomeDescription: result.description }, actor);
				return error(result.error, result.description, undefined, cors);
			}
			await log({ type: 'login', subtype: 'token', action: 'E', outcome: '0', patientId: result.tokens.patient ?? null, details: { grant: 'authorization_code', scope: result.tokens.scope } }, actor);
			return ok(result.tokens, cors);
		}

		case 'refresh_token': {
			const rt = form.get('refresh_token');
			if (!rt) return error('invalid_request', 'refresh_token er påkrevd', undefined, cors);
			const result = await renewWithRefreshToken(rt, client.client_id, form.get('scope') ?? undefined);
			if (!result.ok) {
				await log({ type: 'login', subtype: 'refresh', action: 'E', outcome: '4', outcomeDescription: result.error }, actor);
				return error('invalid_grant', result.error ?? 'Ugyldig refresh token', undefined, cors);
			}
			await log({ type: 'login', subtype: 'refresh', action: 'E', outcome: '0' }, actor);
			return ok(result.tokens, cors);
		}

		case 'client_credentials': {
			// SMART Backend Services. Requires asymmetric client authentication, and
			// can only get `system/` scopes - never patient context.
			if (auth.method !== 'private_key_jwt') {
				return error('invalid_client', 'Backend-tjenester må autentisere med private_key_jwt', undefined, cors);
			}
			const forespurt = form.get('scope') ?? '';
			const innsnevret = narrowIn(forespurt, client.allowed_scopes, new Set(client.allowed_scopes));
			const onlySystem = innsnevret
				.split(/\s+/)
				.filter((s) => s.startsWith('system/'))
				.join(' ');
			if (!onlySystem) {
				await log({ type: 'login', subtype: 'client-credentials', action: 'E', outcome: '4', outcomeDescription: 'ingen gyldige system-scopes' }, actor);
				return error('invalid_scope', 'Ingen av de forespurte scopene er tillatt for denne klienten', undefined, cors);
			}
			const tokens = await issueTokens({ clientId: client.client_id, userId: null, scope: onlySystem, launch: {}, withRefresh: false });
			await log({ type: 'login', subtype: 'client-credentials', action: 'E', outcome: '0', details: { scope: onlySystem } }, actor);
			return ok({ access_token: tokens.access_token, token_type: 'Bearer', expires_in: tokens.expires_in, scope: onlySystem }, cors);
		}

		default:
			return error('unsupported_grant_type', `grant_type «${grantType}» støttes ikke`, undefined, cors);
	}
};
