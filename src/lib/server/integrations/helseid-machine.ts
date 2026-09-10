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
 */

interface Cached {
	token: string;
	expires_at: number;
}

const cache = new Map<string, Cached>();

export async function getMachineToken(scope: string): Promise<string> {
	const cached = cache.get(scope);
	if (cached && Date.now() < cached.expires_at - 30_000) return cached.token;

	const { clientId, privateKeyPem } = config.integrations.healthId;
	if (!clientId || !privateKeyPem) {
		throw new Error('HelseID er ikke konfigurert for maskintilgang');
	}

	const configuration = await helseIdConfiguration();
	let tokens: oidc.TokenEndpointResponse;
	try {
		tokens = await oidc.clientCredentialsGrant(configuration, { scope });
	} catch (err) {
		throw new Error(`HelseID avviste maskintoken: ${(err as Error).message}`);
	}
	const lifetime = tokens.expires_in ?? 60;
	cache.set(scope, { token: tokens.access_token, expires_at: Date.now() + lifetime * 1000 });
	return tokens.access_token;
}

export function emptyCache(): void {
	cache.clear();
}
