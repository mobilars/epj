import { config } from '../config';
import { nyId } from '../util/ids';
import { signer, type Algoritme } from '../auth/jws';
import { hentMetadata } from '../auth/helseid';

/**
 * Maskin-til-maskin-token fra HelseID (client_credentials + private_key_jwt).
 *
 * Brukes av integrasjonene mot SFM og andre nasjonale tjenester. Tokenet
 * caches til like før utløp, slik at vi ikke henter nytt token per kall.
 */

interface Cachet {
	token: string;
	utloper: number;
}

const cache = new Map<string, Cachet>();

export async function hentMaskinToken(scope: string): Promise<string> {
	const cachet = cache.get(scope);
	if (cachet && Date.now() < cachet.utloper - 30_000) return cachet.token;

	const { clientId, privateKeyPem, keyId, signeringsalgoritme } = config.integrasjoner.helseId;
	if (!clientId || !privateKeyPem) {
		throw new Error('HelseID er ikke konfigurert for maskintilgang');
	}
	const meta = await hentMetadata();
	const nå = Math.floor(Date.now() / 1000);
	const assertion = signer(
		{ iss: clientId, sub: clientId, aud: meta.token_endpoint, jti: nyId(), iat: nå, nbf: nå, exp: nå + 60 },
		privateKeyPem,
		keyId,
		'JWT',
		signeringsalgoritme as Algoritme
	);

	const svar = await fetch(meta.token_endpoint, {
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
	if (!svar.ok) {
		throw new Error(`HelseID avviste maskintoken (${svar.status}): ${(await svar.text()).slice(0, 200)}`);
	}
	const kropp = (await svar.json()) as { access_token: string; expires_in: number };
	cache.set(scope, { token: kropp.access_token, utloper: Date.now() + kropp.expires_in * 1000 });
	return kropp.access_token;
}

export function tomCache(): void {
	cache.clear();
}
