import { one, exec, query, transaction } from '../db';
import { requireTenant } from '../tenant/context';
import { config } from '../config';
import { decrypt, encrypt } from '../util/crypto';
import { generateNokkelpar, type Jwk } from './jws';

export interface ActiveKey {
	kid: string;
	privatePem: string;
}

interface KeyRow {
	kid: string;
	alg: string;
	public_jwk: Jwk;
	private_enc: string;
	created_at: string;
	active: boolean;
	phased_out_after: string | null;
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

const cached = new Map<string, { key: ActiveKey; to: number }>();
const jwksCache = new Map<string, { keys: Jwk[]; to: number }>();

function forOld(created_at: string): boolean {
	return Date.now() - new Date(created_at).getTime() > config.oauth.signingKeyRotationDays * 24 * 3600 * 1000;
}

export async function activeSigningKey(): Promise<ActiveKey> {
	const tenantId = requireTenant().id;
	const fromCache = cached.get(tenantId);
	if (fromCache && Date.now() < fromCache.to) return fromCache.key;

	const row = await one<KeyRow>(
		'SELECT * FROM signing_key WHERE tenant_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1',
		[tenantId]
	);
	if (row && !forOld(row.created_at)) {
		const key = { kid: row.kid, privatePem: decrypt(row.private_enc) };
		cached.set(tenantId, { key, to: Date.now() + 300_000 });
		return key;
	}
	return rotateKey();
}

export async function rotateKey(): Promise<ActiveKey> {
	const tenantId = requireTenant().id;
	const { privatePkcs8, publicJwk, kid } = generateNokkelpar();
	await transaction(async () => {
		await exec(
			"UPDATE signing_key SET active = false, phased_out_after = now() + ($1 || ' seconds')::interval WHERE tenant_id = $2 AND active = true",
			[String(config.oauth.accessTokenTtl * 2), tenantId]
		);
		await exec('INSERT INTO signing_key (kid, tenant_id, alg, public_jwk, private_enc, active) VALUES ($1,$2,$3,$4,$5,true)', [
			kid, tenantId, 'ES256', JSON.stringify(publicJwk), encrypt(privatePkcs8)
		]);
	});
	const key = { kid, privatePem: privatePkcs8 };
	cached.set(tenantId, { key, to: Date.now() + 300_000 });
	jwksCache.delete(tenantId);
	return key;
}

/** Alle offentlige nøkler som fortsatt kan verifisere utstedte tokens. */
export async function jwks(): Promise<{ keys: Jwk[] }> {
	const tenantId = requireTenant().id;
	const fromCache = jwksCache.get(tenantId);
	if (fromCache && Date.now() < fromCache.to) return { keys: fromCache.keys };

	const rows = await query<KeyRow>(
		`SELECT * FROM signing_key
		 WHERE tenant_id = $1 AND (active = true OR phased_out_after IS NULL OR phased_out_after > now())
		 ORDER BY created_at DESC`,
		[tenantId]
	);
	if (rows.length === 0) {
		await activeSigningKey();
		return jwks();
	}
	const keys = rows.map((r) => r.public_jwk);
	jwksCache.set(tenantId, { keys, to: Date.now() + 60_000 });
	return { keys };
}

/** Vedlikehold. Går bevisst på tvers av virksomheter: sletter bare utfasede nøkler. */
export async function removeUtdaterteKeys(): Promise<number> {
	jwksCache.clear();
	return exec("DELETE FROM signing_key WHERE active = false AND phased_out_after IS NOT NULL AND phased_out_after < now() - interval '1 day'");
}

/** Brukes av testene. */
export function emptyKeyCache(): void {
	cached.clear();
	jwksCache.clear();
}
