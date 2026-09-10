import { config } from '../config';
import { newId } from '../util/ids';
import { sign, type Algoritme } from '../auth/jws';
import { getMetadata } from '../auth/helseid';

/**
 * Machine-to-machine token from HelseID (client_credentials + private_key_jwt).
 *
 * Used by the integrations towards SFM and other national services. The token
 * is cached until just before expiry, so we do not fetch a new one per call.
 */

interface Cached {
	token: string;
	expires_at: number;
}

const cache = new Map<string, Cached>();

export async function getMachineToken(scope: string): Promise<string> {
	const cached = cache.get(scope);
	if (cached && Date.now() < cached.expires_at - 30_000) return cached.token;

	const { clientId, privateKeyPem, keyId, signeringsalgoritme } = config.integrations.healthId;
	if (!clientId || !privateKeyPem) {
		throw new Error('HelseID er ikke konfigurert for maskintilgang');
	}
	const meta = await getMetadata();
	const now = Math.floor(Date.now() / 1000);
	const assertion = sign(
		{ iss: clientId, sub: clientId, aud: meta.token_endpoint, jti: newId(), iat: now, nbf: now, exp: now + 60 },
		privateKeyPem,
		keyId,
		'JWT',
		signeringsalgoritme as Algoritme
	);

	const response = await fetch(meta.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope,
			client_id: clientId,
			client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
			client_assertion: assertion
		}),
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) {
		throw new Error(`HelseID avviste maskintoken (${response.status}): ${(await response.text()).slice(0, 200)}`);
	}
	const body = (await response.json()) as { access_token: string; expires_in: number };
	cache.set(scope, { token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 });
	return body.access_token;
}

export function emptyCache(): void {
	cache.clear();
}
