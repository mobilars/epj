import { en, exec, query, transaction } from '../db';
import { krevTenant } from '../tenant/kontekst';
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
 * Nøklene er per virksomhet, siden hver virksomhet har sin egen `issuer`.
 * De holdes i minnet mellom kall for å slippe dekryptering per forespørsel.
 */

const cachet = new Map<string, { nokkel: AktivNokkel; til: number }>();
const jwksCache = new Map<string, { keys: Jwk[]; til: number }>();

function forGammel(opprettet: string): boolean {
	return Date.now() - new Date(opprettet).getTime() > config.oauth.signingKeyRotationDays * 24 * 3600 * 1000;
}

export async function aktivSigneringsnokkel(): Promise<AktivNokkel> {
	const tenantId = krevTenant().id;
	const fraCache = cachet.get(tenantId);
	if (fraCache && Date.now() < fraCache.til) return fraCache.nokkel;

	const rad = await en<NokkelRad>(
		'SELECT * FROM signing_key WHERE tenant_id = $1 AND aktiv = true ORDER BY opprettet DESC LIMIT 1',
		[tenantId]
	);
	if (rad && !forGammel(rad.opprettet)) {
		const nokkel = { kid: rad.kid, privatePem: dekrypter(rad.private_enc) };
		cachet.set(tenantId, { nokkel, til: Date.now() + 300_000 });
		return nokkel;
	}
	return roterNokkel();
}

export async function roterNokkel(): Promise<AktivNokkel> {
	const tenantId = krevTenant().id;
	const { privatePkcs8, publicJwk, kid } = genererNokkelpar();
	await transaction(async () => {
		await exec(
			"UPDATE signing_key SET aktiv = false, utfases_etter = now() + ($1 || ' seconds')::interval WHERE tenant_id = $2 AND aktiv = true",
			[String(config.oauth.accessTokenTtl * 2), tenantId]
		);
		await exec('INSERT INTO signing_key (kid, tenant_id, alg, public_jwk, private_enc, aktiv) VALUES ($1,$2,$3,$4,$5,true)', [
			kid, tenantId, 'ES256', JSON.stringify(publicJwk), krypter(privatePkcs8)
		]);
	});
	const nokkel = { kid, privatePem: privatePkcs8 };
	cachet.set(tenantId, { nokkel, til: Date.now() + 300_000 });
	jwksCache.delete(tenantId);
	return nokkel;
}

/** Alle offentlige nøkler som fortsatt kan verifisere utstedte tokens. */
export async function jwks(): Promise<{ keys: Jwk[] }> {
	const tenantId = krevTenant().id;
	const fraCache = jwksCache.get(tenantId);
	if (fraCache && Date.now() < fraCache.til) return { keys: fraCache.keys };

	const rader = await query<NokkelRad>(
		`SELECT * FROM signing_key
		 WHERE tenant_id = $1 AND (aktiv = true OR utfases_etter IS NULL OR utfases_etter > now())
		 ORDER BY opprettet DESC`,
		[tenantId]
	);
	if (rader.length === 0) {
		await aktivSigneringsnokkel();
		return jwks();
	}
	const keys = rader.map((r) => r.public_jwk);
	jwksCache.set(tenantId, { keys, til: Date.now() + 60_000 });
	return { keys };
}

/** Vedlikehold. Går bevisst på tvers av virksomheter: sletter bare utfasede nøkler. */
export async function fjernUtdaterteNokler(): Promise<number> {
	jwksCache.clear();
	return exec("DELETE FROM signing_key WHERE aktiv = false AND utfases_etter IS NOT NULL AND utfases_etter < now() - interval '1 day'");
}

/** Brukes av testene. */
export function tomNokkelCache(): void {
	cachet.clear();
	jwksCache.clear();
}
