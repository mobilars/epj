import { one, exec, transaction } from '../db';
import { fhirBaseFor, requireTenant } from '../tenant/context';
import { config } from '../config';
import { tokenHash } from '../util/crypto';
import { newId, newToken } from '../util/ids';
import type { LaunchContext } from '../authz/context';
import { pkceChallenge, issueTokens, type IssuedToken } from './tokens';
import { validRedirectUri, type OAuthClient } from './clients';

/**
 * Authorisation code flow per OAuth 2.1 and SMART App Launch 2.x.
 *
 * PKCE (S256) is required for every client, confidential ones included. The
 * code is single-use and short-lived, and is bound to client, redirect_uri and
 * user.
 */
export interface CodeIn {
	clientId: string;
	userId: string;
	redirectUri: string;
	scope: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	nonce?: string | null;
	launch: LaunchContext;
}

export async function createAuthorisationCode(inValue: CodeIn): Promise<string> {
	const code = newToken(32);
	await exec(
		`INSERT INTO oauth_authorization_code
		 (code_hash, tenant_id, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, nonce, launch_context, expires_at)
		 VALUES ($1,$11,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)`,
		[
			tokenHash(code), inValue.clientId, inValue.userId, inValue.redirectUri, inValue.scope,
			inValue.codeChallenge, inValue.codeChallengeMethod, inValue.nonce ?? null,
			JSON.stringify(inValue.launch), String(config.oauth.authorizationCodeTtl), requireTenant().id
		]
	);
	return code;
}

export type CodeExchange =
	| { ok: true; tokens: IssuedToken }
	| { ok: false; error: string; description: string };

export async function exchangeInCode(
	code: string,
	client: OAuthClient,
	redirectUri: string,
	codeVerifier: string | null
): Promise<CodeExchange> {
	return transaction(async () => {
		const row = await one<{
			code_hash: string; client_id: string; user_id: string; redirect_uri: string; scope: string;
			code_challenge: string; code_challenge_method: string; nonce: string | null;
			launch_context: LaunchContext; expires_at: string; used: boolean;
		}>('SELECT * FROM oauth_authorization_code WHERE code_hash = $1 AND tenant_id = $2 FOR UPDATE', [
			tokenHash(code), requireTenant().id
		]);

		if (!row) return { ok: false as const, error: 'invalid_grant', description: 'Ukjent autorisasjonskode' };
		if (row.used) {
			// Code reuse: revoke everything issued to the client for that user.
			await exec(
				"UPDATE oauth_token SET revoked = true, revoked_reason = 'gjenbruk av autorisasjonskode' WHERE client_id = $1 AND user_id = $2 AND tenant_id = $3",
				[row.client_id, row.user_id, requireTenant().id]
			);
			return { ok: false as const, error: 'invalid_grant', description: 'Autorisasjonskoden er allerede brukt' };
		}
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			return { ok: false as const, error: 'invalid_grant', description: 'Autorisasjonskoden er utløpt' };
		}
		if (row.client_id !== client.client_id) {
			return { ok: false as const, error: 'invalid_grant', description: 'Koden tilhører en annen klient' };
		}
		if (row.redirect_uri !== redirectUri) {
			return { ok: false as const, error: 'invalid_grant', description: 'redirect_uri stemmer ikke med autorisasjonsforespørselen' };
		}
		if (!codeVerifier) {
			return { ok: false as const, error: 'invalid_request', description: 'code_verifier mangler' };
		}
		const expected = row.code_challenge_method === 'S256' ? pkceChallenge(codeVerifier) : codeVerifier;
		if (expected !== row.code_challenge) {
			return { ok: false as const, error: 'invalid_grant', description: 'PKCE-verifisering feilet' };
		}

		await exec('UPDATE oauth_authorization_code SET used = true WHERE code_hash = $1 AND tenant_id = $2', [row.code_hash, requireTenant().id]);

		const scopes = row.scope.split(/\s+/);
		const tokens = await issueTokens({
			clientId: client.client_id,
			userId: row.user_id,
			scope: row.scope,
			launch: row.launch_context ?? {},
			withRefresh: scopes.includes('offline_access') || scopes.includes('online_access'),
			nonce: row.nonce
		});
		return { ok: true as const, tokens };
	});
}

/** EHR launch: the record creates context before the SMART app opens. */
export async function createLaunch(inValue: {
	clientId: string;
	userId: string;
	patientId?: string | null;
	encounterId?: string | null;
	intent?: string | null;
}): Promise<string> {
	const launchId = newToken(24);
	await exec(
		`INSERT INTO smart_launch (launch_id, tenant_id, client_id, user_id, patient_id, encounter_id, intent, expires_at)
		 VALUES ($1,$8,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
		[launchId, inValue.clientId, inValue.userId, inValue.patientId ?? null, inValue.encounterId ?? null, inValue.intent ?? null, String(config.oauth.launchTtl), requireTenant().id]
	);
	return launchId;
}

export async function consumeLaunch(launchId: string, clientId: string, userId: string): Promise<LaunchContext | null> {
	const row = await one<{ patient_id: string | null; encounter_id: string | null; intent: string | null; used: boolean; expires_at: string; client_id: string; user_id: string }>(
		'SELECT patient_id, encounter_id, intent, used, expires_at, client_id, user_id FROM smart_launch WHERE launch_id = $1 AND tenant_id = $2',
		[launchId, requireTenant().id]
	);
	if (!row || row.used) return null;
	if (row.client_id !== clientId || row.user_id !== userId) return null;
	if (new Date(row.expires_at).getTime() <= Date.now()) return null;
	await exec('UPDATE smart_launch SET used = true WHERE launch_id = $1 AND tenant_id = $2', [launchId, requireTenant().id]);
	return { patientId: row.patient_id, encounterId: row.encounter_id, intent: row.intent };
}

export interface AutorisasjonsRequest {
	response_type: string;
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
	aud?: string;
	launch?: string;
	code_challenge?: string;
	code_challenge_method?: string;
	nonce?: string;
	prompt?: string;
}

export type Validation =
	| { ok: true; request: AutorisasjonsRequest; client: OAuthClient }
	| { ok: false; error: string; description: string; canRedirect: boolean; redirectUri?: string; state?: string };

/**
 * Validates the authorisation request.
 *
 * Errors in `client_id`/`redirect_uri` must never be redirected back - that
 * would let an attacker use the record as an open redirector.
 */
export function validateAuthorisationRequest(
	search: URLSearchParams,
	client: OAuthClient | null
): Validation {
	const f: AutorisasjonsRequest = {
		response_type: search.get('response_type') ?? '',
		client_id: search.get('client_id') ?? '',
		redirect_uri: search.get('redirect_uri') ?? '',
		scope: search.get('scope') ?? '',
		state: search.get('state') ?? '',
		aud: search.get('aud') ?? undefined,
		launch: search.get('launch') ?? undefined,
		code_challenge: search.get('code_challenge') ?? undefined,
		code_challenge_method: search.get('code_challenge_method') ?? undefined,
		nonce: search.get('nonce') ?? undefined,
		prompt: search.get('prompt') ?? undefined
	};

	const reject = (error: string, description: string, canRedirect = true): Validation => ({
		ok: false, error, description, canRedirect,
		redirectUri: canRedirect ? f.redirect_uri : undefined,
		state: f.state
	});

	if (!client) return reject('unauthorized_client', 'Ukjent client_id', false);
	if (client.status !== 'aktiv') return reject('unauthorized_client', 'Klienten er sperret', false);
	if (!validRedirectUri(client, f.redirect_uri)) return reject('invalid_request', 'redirect_uri er ikke registrert', false);
	if (f.response_type !== 'code') return reject('unsupported_response_type', 'Kun response_type=code støttes');
	if (!f.state) return reject('invalid_request', 'state er påkrevd');
	if (!f.code_challenge) return reject('invalid_request', 'PKCE (code_challenge) er påkrevd');
	if ((f.code_challenge_method ?? 'plain') !== 'S256') return reject('invalid_request', 'code_challenge_method må være S256');
	if (!client.grant_types.includes('authorization_code')) return reject('unauthorized_client', 'Klienten kan ikke bruke authorization_code');
	const fhirBase = fhirBaseFor(requireTenant());
	if (f.aud && !f.aud.startsWith(fhirBase) && f.aud !== fhirBase) {
		return reject('invalid_request', `aud må være ${fhirBase}`);
	}
	if (f.scope.split(/\s+/).includes('launch') && !f.launch) {
		return reject('invalid_request', 'scope «launch» krever parameteren launch');
	}

	return { ok: true, request: f, client };
}

export function errorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set('error', error);
	url.searchParams.set('error_description', description);
	if (state) url.searchParams.set('state', state);
	return url.toString();
}

/** Maintenance. Deliberately across organisations: deletes only expired rows. */
export async function purgeUtlopteCodes(): Promise<number> {
	const a = await exec("DELETE FROM oauth_authorization_code WHERE expires_at < now() - interval '1 day'");
	const b = await exec("DELETE FROM smart_launch WHERE expires_at < now() - interval '1 day'");
	return a + b;
}

export function newStateValue(): string {
	return newId();
}
