import { en, exec, query, transaction } from '../db';
import { config } from '../config';
import { dekrypter, krypter } from '../util/crypto';
import { genererNokkelpar, type Jwk } from './jws';

export interface AktivNokkel {
	kid: string;
	privatePem: string;
}

interface NokkelRad {
	kid: string;
	alg: string;
	public_jwk: Jwk;
	private_enc: string;
	opprettet: string;
	aktiv: boolean;
	utfases_etter: string | null;
}

/**
 * Signeringsnøkler for access tokens og id_token.
 *
 * Nøklene lagres kryptert med EPJ_DATA_KEY og roteres etter en konfigurerbar
 * periode. Gammel nøkkel blir liggende i JWKS til allerede utstedte tokens er
 * utløpt, slik at rotasjon ikke gir nedetid for SMART-apper.
 *
 * Nøkkelen holdes i minnet mellom kall for å slippe dekryptering per forespørsel.
 */

let cachet: { nokkel: AktivNokkel; til: number } | null = null;
let jwksCache: { keys: Jwk[]; til: number } | null = null;

function forGammel(opprettet: string): boolean {
	return Date.now() - new Date(opprettet).getTime() > config.oauth.signingKeyRotationDays * 24 * 3600 * 1000;
}

export async function aktivSigneringsnokkel(): Promise<AktivNokkel> {
	if (cachet && Date.now() < cachet.til) return cachet.nokkel;

	const rad = await en<NokkelRad>('SELECT * FROM signing_key WHERE aktiv = true ORDER BY opprettet DESC LIMIT 1');
	if (rad && !forGammel(rad.opprettet)) {
		const nokkel = { kid: rad.kid, privatePem: dekrypter(rad.private_enc) };
		cachet = { nokkel, til: Date.now() + 300_000 };
		return nokkel;
	}
	return roterNokkel();
}

export async function roterNokkel(): Promise<AktivNokkel> {
	const { privatePkcs8, publicJwk, kid } = genererNokkelpar();
	await transaction(async () => {
		await exec(
			"UPDATE signing_key SET aktiv = false, utfases_etter = now() + ($1 || ' seconds')::interval WHERE aktiv = true",
			[String(config.oauth.accessTokenTtl * 2)]
		);
		await exec('INSERT INTO signing_key (kid, alg, public_jwk, private_enc, aktiv) VALUES ($1,$2,$3,$4,true)', [
			kid, 'ES256', JSON.stringify(publicJwk), krypter(privatePkcs8)
		]);
	});
	const nokkel = { kid, privatePem: privatePkcs8 };
	cachet = { nokkel, til: Date.now() + 300_000 };
	jwksCache = null;
	return nokkel;
}

/** Alle offentlige nøkler som fortsatt kan verifisere utstedte tokens. */
export async function jwks(): Promise<{ keys: Jwk[] }> {
	if (jwksCache && Date.now() < jwksCache.til) return { keys: jwksCache.keys };
	const rader = await query<NokkelRad>(
		'SELECT * FROM signing_key WHERE aktiv = true OR utfases_etter IS NULL OR utfases_etter > now() ORDER BY opprettet DESC'
	);
	if (rader.length === 0) {
		await aktivSigneringsnokkel();
		return jwks();
	}
	const keys = rader.map((r) => r.public_jwk);
	jwksCache = { keys, til: Date.now() + 60_000 };
	return { keys };
}

export async function fjernUtdaterteNokler(): Promise<number> {
	jwksCache = null;
	return exec("DELETE FROM signing_key WHERE aktiv = false AND utfases_etter IS NOT NULL AND utfases_etter < now() - interval '1 day'");
}

/** Brukes av testene. */
export function tomNokkelCache(): void {
	cachet = null;
	jwksCache = null;
}
