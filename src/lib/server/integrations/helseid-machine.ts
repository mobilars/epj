import * as oidc from 'openid-client';
import { config } from '../config';
import { helseIdConfiguration } from '../auth/helseid';

/**
 * Machine-to-machine token from HelseID (client_credentials + private_key_jwt).
 *
 * Used by the integrations towards SFM and other national services. The client
 * assertion is built by openid-client from the same configuration the sign-in
 * flow uses. The token is cached until just before expiry, so we do not fetch a
 * new one per call.
 *
 * A client with API scopes must bind its tokens to a key with DPoP (RFC 9449).
 * Unlike the sign-in flow, where the key belongs to one attempt and travels in
 * a cookie, this key belongs to the process and lives as long as it does: the
 * token it is bound to is cached alongside it, so the two cannot drift apart.
 *
 * That binding continues past the token endpoint. A DPoP-bound token is sent as
 * `Authorization: DPoP <token>` with a fresh proof per request - not as a
 * Bearer token - so a caller reaching a protected API must use the handle from
 * `getMachineAccess`, through `oidc.fetchProtectedResource` or an equivalent.
 * The integrations run against the local simulator today and do not exercise
 * this; see docs/todo.md §3.5 before pointing them at NHN.
 */

interface Cached {
	token: string;
	tokenType: string;
	expires_at: number;
}

const cache = new Map<string, Cached>();
let dpopKeys: oidc.CryptoKeyPair | null = null;

async function dpopHandle(configuration: oidc.Configuration): Promise<oidc.DPoPHandle> {
	dpopKeys ??= await oidc.randomDPoPKeyPair('ES256');
	return oidc.getDPoPHandle(configuration, dpopKeys);
}

export interface MachineAccess {
	token: string;
	/** `DPoP` for a key-bound token, `Bearer` otherwise. */
	tokenType: string;
	/** The proof handle the token is bound to. Required on every API call. */
	dpop: oidc.DPoPHandle;
}

export async function getMachineAccess(scope: string): Promise<MachineAccess> {
	const configuration = await helseIdConfiguration();
	const DPoP = await dpopHandle(configuration);

	const cached = cache.get(scope);
	if (cached && Date.now() < cached.expires_at - 30_000) {
		return { token: cached.token, tokenType: cached.tokenType, dpop: DPoP };
	}

	const { clientId, privateJwkBase64, privateKeyPem } = config.integrations.healthId;
	if (!clientId || !(privateJwkBase64 || privateKeyPem)) {
		throw new Error('HelseID er ikke konfigurert for maskintilgang');
	}

	let tokens: oidc.TokenEndpointResponse;
	try {
		tokens = await oidc.clientCredentialsGrant(configuration, { scope }, { DPoP });
	} catch (err) {
		throw new Error(`HelseID avviste maskintoken: ${(err as Error).message}`);
	}
	const lifetime = tokens.expires_in ?? 60;
	const tokenType = tokens.token_type ?? 'Bearer';
	cache.set(scope, { token: tokens.access_token, tokenType, expires_at: Date.now() + lifetime * 1000 });
	return { token: tokens.access_token, tokenType, dpop: DPoP };
}

export async function getMachineToken(scope: string): Promise<string> {
	return (await getMachineAccess(scope)).token;
}

export function emptyCache(): void {
	cache.clear();
	dpopKeys = null;
}
