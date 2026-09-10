import type { Cookies } from '@sveltejs/kit';
import * as oidc from 'openid-client';
import { importJWK, importPKCS8, type JWK } from 'jose';
import { config } from '../config';
import { decrypt, encrypt } from '../util/crypto';
import { one, exec, transaction } from '../db';
import { requireTenant, issuerFor } from '../tenant/context';
import { createUser, getUser, rolesFor, type User } from './users';
import type { Role } from '../authz/roles';

/**
 * HelseID as identity provider.
 *
 * HelseID is the national sign-in service for health personnel, operated by
 * Norsk helsenett. The record acts as an OIDC client using the authorisation
 * code flow, PKCE and `private_key_jwt` - no shared secret sits in the
 * configuration.
 *
 * The protocol itself is handled by `openid-client`: discovery, PKCE, the
 * client assertion, and validation of the id_token (issuer, audience, nonce,
 * signature and expiry). Writing that by hand is where OIDC clients go wrong,
 * and it is not the part of the flow this record adds anything to.
 *
 * From the id_token/userinfo we take:
 *   - `helseid://claims/identity/pid`            national identity number
 *   - `helseid://claims/hpr/hpr_number`          HPR number
 *   - `helseid://claims/identity/security_level` security level (4 required)
 *   - `name`                                     name
 *
 * Users are provisioned on first sign-in but get no roles automatically:
 * assigning a role is an administrative act and must leave a trace.
 *
 * The link is per organisation. The same doctor may work at several practices,
 * and then holds one account at each - with its own roles and relationships.
 */

export const CLAIM = {
	PID: 'helseid://claims/identity/pid',
	PID_PSEUDONYM: 'helseid://claims/identity/pid_pseudonym',
	SECURITY_LEVEL: 'helseid://claims/identity/security_level',
	HPR_NUMBER: 'helseid://claims/hpr/hpr_number',
	ASSURANCE_LEVEL: 'helseid://claims/identity/assurance_level',
	ORGNR_PARENT: 'helseid://claims/client/claims/orgnr_parent'
} as const;

/** HelseID refuses a client assertion valid for more than ten seconds. */
const HELSEID_ASSERTION_LIFETIME = 10;

let cachedConfiguration: { value: oidc.Configuration; expiresAt: number } | null = null;

/**
 * Discovers HelseID and builds the client configuration.
 *
 * The result is kept for an hour: discovery is a network call, and the JWKS
 * cache openid-client keeps inside the configuration is what lets it verify
 * id_tokens without fetching keys on every sign-in.
 */
export async function helseIdConfiguration(): Promise<oidc.Configuration> {
	if (cachedConfiguration && Date.now() < cachedConfiguration.expiresAt) return cachedConfiguration.value;
	const { issuer, clientId } = config.integrations.healthId;
	if (!clientId) throw new Error('HelseID client id is missing (EPJ_HELSEID_CLIENT_ID)');

	const value = await oidc.discovery(new URL(issuer), clientId, undefined, oidc.PrivateKeyJwt(await clientKey(), {
		/**
		 * HelseID's own requirements on the client assertion, beyond RFC 7523:
		 *
		 *   - `typ` must be `client-authentication+jwt`. With a plain `JWT` the
		 *     assertion is refused as invalid_client.
		 *   - `exp` must be at most ten seconds ahead. openid-client's default of
		 *     one minute is accepted for now, but logged as deprecated.
		 *
		 * `aud` is the issuer identifier, which is what openid-client already
		 * sends - not the token endpoint.
		 *
		 * https://utviklerportal.nhn.no/informasjonstjenester/helseid/bruksmoenstre-og-eksempelkode/bruk-av-helseid/docs/tekniske-mekanismer/bruk_av_client_assertion_no_nbmd
		 */
		[oidc.modifyAssertion]: (header, payload) => {
			header.typ = 'client-authentication+jwt';
			payload.exp = (payload.iat as number) + HELSEID_ASSERTION_LIFETIME;
		}
	}));
	cachedConfiguration = { value, expiresAt: Date.now() + 3600_000 };
	return value;
}

/**
 * The key the client assertions are signed with.
 *
 * A JWK is preferred: it carries its own `kid` and `alg`, and HelseID picks the
 * registered key to check the assertion against by `kid`. Deriving the `kid`
 * ourselves - as an RFC 7638 thumbprint, say - only works if HelseID happened to
 * register the key under that same id. The PEM form remains for environments
 * configured before the JWK was available.
 */
async function clientKey(): Promise<oidc.CryptoKey | oidc.PrivateKey> {
	const { privateJwkBase64, privateKeyPem, keyId, signingAlgorithm } = config.integrations.healthId;
	if (privateJwkBase64) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(privateJwkBase64, 'base64').toString('utf8'));
		} catch (err) {
			throw new Error(`EPJ_HELSEID_PRIVATE_JWK is not base64-encoded JSON: ${(err as Error).message}`);
		}
		const jwk = (Array.isArray(parsed) ? parsed[0] : parsed) as JWK | undefined;
		if (!jwk?.kty) throw new Error('EPJ_HELSEID_PRIVATE_JWK holds no JWK');
		const alg = jwk.alg ?? signingAlgorithm;
		const key = await importJWK(jwk, alg);
		if (!('type' in key)) throw new Error('EPJ_HELSEID_PRIVATE_JWK is a symmetric key, not a signing key');
		return { key: key as oidc.CryptoKey, kid: jwk.kid };
	}
	if (!privateKeyPem) {
		throw new Error('HelseID client key is missing (EPJ_HELSEID_PRIVATE_JWK or EPJ_HELSEID_PRIVATE_KEY)');
	}
	return { key: await importPKCS8(privateKeyPem, signingAlgorithm), kid: keyId || undefined };
}

/** Used by the tests, and after a configuration change. */
export function clearConfigurationCache(): void {
	cachedConfiguration = null;
}

const STATE_COOKIE = 'epj_helseid';

interface FlowState {
	state: string;
	nonce: string;
	codeVerifier: string;
	returnTo: string;
	created_at: number;
}

/** Builds the authorisation URL and puts the flow state in an encrypted cookie. */
export async function startLogin(cookies: Cookies, returnTo: string): Promise<string> {
	const configuration = await helseIdConfiguration();
	const state = oidc.randomState();
	const nonce = oidc.randomNonce();
	const codeVerifier = oidc.randomPKCECodeVerifier();
	const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

	const flowState: FlowState = { state, nonce, codeVerifier, returnTo, created_at: Date.now() };
	cookies.set(STATE_COOKIE, encrypt(JSON.stringify(flowState)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax', // must survive the redirect back from HelseID
		secure: config.security.httpsOnly,
		maxAge: 600
	});

	const parameters = {
		redirect_uri: redirectUri(),
		scope: config.integrations.healthId.scopes.join(' '),
		state,
		nonce,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256'
	};

	// HelseID requires the request to be pushed to the authorization server
	// first (RFC 9126), so the parameters never travel through the browser. The
	// push is authenticated with the same client assertion as the token call.
	const url = configuration.serverMetadata().pushed_authorization_request_endpoint
		? await oidc.buildAuthorizationUrlWithPAR(configuration, parameters)
		: oidc.buildAuthorizationUrl(configuration, parameters);
	return url.toString();
}

export function redirectUri(): string {
	// The callback address must sit on the organisation's own hostname, since
	// that is where the session is created.
	return config.integrations.healthId.redirectUri || `${issuerFor(requireTenant())}/logg-inn/helseid/tilbake`;
}

function readState(cookies: Cookies): FlowState | null {
	const raw = cookies.get(STATE_COOKIE);
	if (!raw) return null;
	try {
		const t = JSON.parse(decrypt(raw)) as FlowState;
		if (Date.now() - t.created_at > 600_000) return null;
		return t;
	} catch {
		return null;
	}
}

export function endFlow(cookies: Cookies): void {
	cookies.delete(STATE_COOKIE, { path: '/' });
}

export interface HelseIdClaims {
	sub: string;
	name: string;
	pid: string | null;
	hprNumber: string | null;
	securityLevel: string | null;
	raw: Record<string, unknown>;
}

export type LoginResult =
	| { ok: true; claims: HelseIdClaims; returnTo: string; user: User; roles: Role[]; newUser: boolean }
	| { ok: false; error: string };

/**
 * Completes the flow: exchanges the code for tokens, verifies the id_token and
 * links or creates the local user.
 *
 * `currentUrl` is the callback address exactly as it was requested. It is what
 * openid-client checks `iss`, `state` and any error response against.
 */
export async function completeLogin(cookies: Cookies, currentUrl: URL): Promise<LoginResult> {
	const flowState = readState(cookies);
	endFlow(cookies);
	if (!flowState) return { ok: false, error: 'Påloggingen tok for lang tid. Prøv igjen.' };

	let claims: Record<string, unknown>;
	try {
		const configuration = await helseIdConfiguration();
		const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
			pkceCodeVerifier: flowState.codeVerifier,
			expectedState: flowState.state,
			expectedNonce: flowState.nonce,
			idTokenExpected: true
		});
		const verified = tokens.claims();
		if (!verified) return { ok: false, error: 'HelseID returnerte ikke id_token' };
		// HelseID does not necessarily put pid, HPR number and security level in
		// the id_token - which ones appear there depends on how the client is
		// registered. Userinfo is asked as well and fills the gaps; the id_token
		// still wins where the two overlap, since that is the signed document.
		let fromUserinfo: Record<string, unknown> = {};
		try {
			fromUserinfo = (await oidc.fetchUserInfo(configuration, tokens.access_token, verified.sub)) as unknown as Record<
				string,
				unknown
			>;
		} catch {
			/* userinfo is a bonus; the id_token is what authenticates */
		}
		claims = { ...fromUserinfo, ...(verified as unknown as Record<string, unknown>) };
	} catch (err) {
		return { ok: false, error: `HelseID avviste innloggingen: ${describeOAuthError(err)}` };
	}

	const securityLevel = (claims[CLAIM.SECURITY_LEVEL] as string) ?? null;
	if (securityLevel && securityLevel !== '4') {
		return { ok: false, error: `Innlogging krever sikkerhetsnivå 4 (fikk ${securityLevel})` };
	}

	const parsed: HelseIdClaims = {
		sub: String(claims.sub),
		name: (claims.name as string) ?? 'Ukjent',
		pid: (claims[CLAIM.PID] as string) ?? null,
		hprNumber: (claims[CLAIM.HPR_NUMBER] as string) ?? null,
		securityLevel,
		raw: claims
	};

	const { user, roles, newUser } = await linkToLocalUser(parsed);
	return { ok: true, claims: parsed, returnTo: flowState.returnTo, user, roles, newUser };
}

/**
 * Unwraps what the authorization server actually said.
 *
 * openid-client's own message for a failed token exchange is "server responded
 * with an error in the response body" - the `error` and `error_description`
 * that say why sit on the error object. Without unwrapping them, a
 * configuration fault is indistinguishable from HelseID being down, both in the
 * message shown to the user and in the security log.
 */
export function describeOAuthError(err: unknown): string {
	if (err instanceof oidc.ResponseBodyError || err instanceof oidc.AuthorizationResponseError) {
		return err.error_description ? `${err.error} - ${err.error_description}` : err.error;
	}
	if (err instanceof oidc.ClientError && err.cause) {
		return `${(err as Error).message} (${String((err.cause as { error?: string }).error ?? err.cause)})`;
	}
	return (err as Error).message;
}

/**
 * Finds the local user for a HelseID identity, or creates it.
 *
 * Linking is on `sub` (stable in HelseID) and secondarily on HPR number, so a
 * user pre-registered by the system administrator is linked automatically on
 * first sign-in. New users are created without roles and without access.
 */
export async function linkToLocalUser(
	claims: HelseIdClaims
): Promise<{ user: User; roles: Role[]; newUser: boolean }> {
	return transaction(async () => {
		const tenantId = requireTenant().id;
		let row = await one<{ id: string }>(
			'SELECT id FROM user_account WHERE helseid_sub = $1 AND tenant_id = $2',
			[claims.sub, tenantId]
		);

		if (!row && claims.hprNumber) {
			row = await one<{ id: string }>(
				'SELECT id FROM user_account WHERE hpr_number = $1 AND tenant_id = $2 AND helseid_sub IS NULL',
				[claims.hprNumber, tenantId]
			);
			if (row) {
				await exec('UPDATE user_account SET helseid_sub = $2, name = $3, updated_at = now() WHERE id = $1', [row.id, claims.sub, claims.name]);
			}
		}

		if (row) {
			await exec('UPDATE user_account SET last_login = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1', [row.id]);
			const user = await getUser(row.id);
			if (!user) throw new Error('Fant ikke brukeren etter kobling');
			return { user, roles: await rolesFor(user.id), newUser: false };
		}

		const username = claims.hprNumber ? `hpr-${claims.hprNumber}` : `helseid-${claims.sub.slice(0, 12)}`;
		const user = await createUser({
			username,
			name: claims.name,
			hprNumber: claims.hprNumber ?? undefined,
			roles: [] // roles are assigned by the system administrator
		});
		await exec('UPDATE user_account SET helseid_sub = $2, must_change_password = false, last_login = now() WHERE id = $1', [user.id, claims.sub]);
		const updated = await getUser(user.id);
		return { user: updated ?? user, roles: [], newUser: true };
	});
}

export function isConfigured(): boolean {
	const h = config.integrations.healthId;
	return h.enabled && Boolean(h.clientId) && Boolean(h.privateJwkBase64 || h.privateKeyPem);
}
