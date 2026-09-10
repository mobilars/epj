import { one, exec, query } from '../db';
import { requireTenant, issuerFor } from '../tenant/context';
import { hashPassword, likeStrenger, tokenHash, verifyPassword } from '../util/crypto';
import { newId, newToken } from '../util/ids';
import { verify as verifyJws, decodeWithoutVerification, type Jwk } from './jws';
import { config } from '../config';
import { getJsonUtenfra, checkOutboundUrl, OutboundError } from '../util/outbound';

export type ClientCategory = 'smart-ehr' | 'smart-standalone' | 'backend' | 'internal';

export interface OAuthClient {
	client_id: string;
	name: string;
	type: 'public' | 'confidential';
	client_category: ClientCategory;
	secret_hash: string | null;
	jwks: { keys: Jwk[] } | null;
	jwks_uri: string | null;
	redirect_uris: string[];
	allowed_scopes: string[];
	grant_types: string[];
	require_pkce: boolean;
	require_consent: boolean;
	logo_url: string | null;
	tenant_id: string;
	databehandleravtale: string | null;
	/** URL the record sends the user to on EHR launch. */
	launch_url: string | null;
	status: string;
	created_at: string;
}

const FIELD = `client_id, tenant_id, name, type, client_category, secret_hash, jwks, jwks_uri, redirect_uris,
	allowed_scopes, grant_types, require_pkce, require_consent, logo_url, databehandleravtale, launch_url, status, created_at`;

export async function getClient(clientId: string): Promise<OAuthClient | null> {
	return one<OAuthClient>(`SELECT ${FIELD} FROM oauth_client WHERE client_id = $1 AND tenant_id = $2`, [
		clientId, requireTenant().id
	]);
}

export async function listClients(): Promise<OAuthClient[]> {
	return query<OAuthClient>(`SELECT ${FIELD} FROM oauth_client WHERE tenant_id = $1 ORDER BY name`, [
		requireTenant().id
	]);
}

export interface NewClient {
	name: string;
	type: 'public' | 'confidential';
	category: ClientCategory;
	redirectUris: string[];
	scopes: string[];
	grantTypes?: string[];
	jwks?: { keys: Jwk[] };
	jwksUri?: string;
	logoUrl?: string;
	databehandleravtale?: string;
	launchUrl?: string;
	createdOf?: string;
}

export async function registerClient(inValue: NewClient): Promise<{ client: OAuthClient; secret?: string }> {
	const clientId = `epj-${newId()}`;
	const secret = inValue.type === 'confidential' && !inValue.jwks && !inValue.jwksUri ? newToken(32) : undefined;
	await exec(
		`INSERT INTO oauth_client (client_id, tenant_id, name, type, client_category, secret_hash, jwks, jwks_uri,
			redirect_uris, allowed_scopes, grant_types, require_pkce, logo_url, databehandleravtale, launch_url, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		[
			clientId, requireTenant().id, inValue.name, inValue.type, inValue.category, secret ? hashPassword(secret) : null,
			inValue.jwks ? JSON.stringify(inValue.jwks) : null, inValue.jwksUri ?? null,
			JSON.stringify(inValue.redirectUris), JSON.stringify(inValue.scopes),
			JSON.stringify(inValue.grantTypes ?? (inValue.category === 'backend' ? ['client_credentials'] : ['authorization_code', 'refresh_token'])),
			inValue.type === 'public', inValue.logoUrl ?? null, inValue.databehandleravtale ?? null, inValue.launchUrl ?? null, inValue.createdOf ?? null
		]
	);
	const client = await getClient(clientId);
	if (!client) throw new Error('Klarte ikke å registrere klienten');
	return { client, secret };
}

export async function setKlientstatus(clientId: string, status: 'aktiv' | 'sperret'): Promise<void> {
	const tenantId = requireTenant().id;
	await exec('UPDATE oauth_client SET status = $2 WHERE client_id = $1 AND tenant_id = $3', [clientId, status, tenantId]);
	if (status === 'sperret') {
		await exec(
			"UPDATE oauth_token SET revoked = true, revoked_reason = 'klient sperret' WHERE client_id = $1 AND tenant_id = $2",
			[clientId, tenantId]
		);
	}
}

/** Exact comparison of redirect_uri, with no pattern matching (OAuth 2.1). */
export function validRedirectUri(client: OAuthClient, uri: string): boolean {
	return client.redirect_uris.some((r) => likeStrenger(r, uri));
}

export type ClientAutentisering =
	| { ok: true; client: OAuthClient; method: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' }
	| { ok: false; error: string };

/**
 * Authenticates the client at the token endpoint.
 *
 * For service-to-service access (SMART Backend Services) `private_key_jwt` is
 * required - that is also HelseID's requirement for organisation-certificate
 * integrations, and means no shared secret has to sit with the client.
 */
export async function authenticateClient(
	form: URLSearchParams,
	authorizationHeader: string | null
): Promise<ClientAutentisering> {
	let clientId = form.get('client_id') ?? undefined;
	let clientSecret: string | undefined;
	let method: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' = 'none';

	if (authorizationHeader?.toLowerCase().startsWith('basic ')) {
		const dekodet = Buffer.from(authorizationHeader.slice(6), 'base64').toString('utf8');
		const skille = dekodet.indexOf(':');
		if (skille < 0) return { ok: false, error: 'Ugyldig Basic-header' };
		try {
			clientId = decodeURIComponent(dekodet.slice(0, skille));
			clientSecret = decodeURIComponent(dekodet.slice(skille + 1));
		} catch {
			// Bad percent-encoding should give 401, not an unhandled error and 500.
			return { ok: false, error: 'Ugyldig Basic-header' };
		}
		method = 'client_secret_basic';
	} else if (form.get('client_secret')) {
		clientSecret = form.get('client_secret') ?? undefined;
		method = 'client_secret_post';
	}

	const assertion = form.get('client_assertion');
	const assertionType = form.get('client_assertion_type');
	if (assertion && assertionType === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
		const dekodet = decodeWithoutVerification(assertion);
		clientId = clientId ?? (dekodet?.payload.sub as string | undefined);
		method = 'private_key_jwt';
	}

	if (!clientId) return { ok: false, error: 'client_id mangler' };
	const client = await getClient(clientId);
	if (!client) return { ok: false, error: 'Ukjent klient' };
	if (client.status !== 'aktiv') return { ok: false, error: 'Klienten er sperret' };

	if (method === 'private_key_jwt') {
		const keys = await clientKeys(client);
		if (keys.length === 0) return { ok: false, error: 'Klienten har ingen registrerte nøkler' };
		try {
			const payload = await verifyJws(assertion as string, keys);
			if (payload.iss !== clientId || payload.sub !== clientId) return { ok: false, error: 'Ugyldig iss/sub i client_assertion' };
			// The token endpoint belongs to the organisation. An assertion issued
			// against one organisation must not work against another.
			const issuer = issuerFor(requireTenant());
			const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
			if (!aud.includes(`${issuer}/oauth/token`) && !aud.includes(issuer)) {
				return { ok: false, error: 'Ugyldig aud i client_assertion' };
			}
			if (typeof payload.jti !== 'string' || await jtiBrukt(payload.jti)) {
				return { ok: false, error: 'client_assertion mangler jti eller er gjenbrukt' };
			}
			// RFC 7523 requires `exp`. Without it the assertion is valid forever, and
			// a leaked one becomes a permanent credential. `verify` rejects an
			// expired `exp` but accepts a missing one - here it is mandatory.
			const now = Math.floor(Date.now() / 1000);
			if (typeof payload.exp !== 'number') {
				return { ok: false, error: 'client_assertion mangler exp' };
			}
			if (payload.exp > now + 3600) {
				return { ok: false, error: 'client_assertion har for lang levetid (maks én time)' };
			}
			await storeJti(payload.jti, payload.exp);
		} catch (err) {
			return { ok: false, error: `Ugyldig client_assertion: ${(err as Error).message}` };
		}
		return { ok: true, client, method };
	}

	if (client.type === 'confidential') {
		if (!clientSecret || !client.secret_hash || !verifyPassword(clientSecret, client.secret_hash)) {
			return { ok: false, error: 'Ugyldig klienthemmelighet' };
		}
		return { ok: true, client, method };
	}

	// Public clients are not authenticated; PKCE is required instead.
	return { ok: true, client, method: 'none' };
}

async function clientKeys(client: OAuthClient): Promise<Jwk[]> {
	if (client.jwks?.keys?.length) return client.jwks.keys;
	if (!client.jwks_uri) return [];
	try {
		// `jwks_uri` is a form field, not deployment configuration. Without the
		// check in `checkOutboundUrl`, whoever registers an app could make the
		// record fetch arbitrary internal addresses - HAPI, the database, the API
		// server, or the cloud metadata service.
		const jwks = (await getJsonUtenfra(client.jwks_uri)) as { keys?: Jwk[] };
		return jwks.keys ?? [];
	} catch (err) {
		if (err instanceof OutboundError) {
			console.warn(`[oauth] jwks_uri for ${client.client_id} ble avvist: ${err.message}`);
		}
		return [];
	}
}

/** Checks `jwks_uri` at registration, so the mistake surfaces where it is made. */
export async function validJwksUri(uri: string): Promise<string | null> {
	try {
		await checkOutboundUrl(uri);
		return null;
	} catch (err) {
		return err instanceof OutboundError ? err.message : 'Adressen kunne ikke kontrolleres';
	}
}

// jti values are kept briefly to stop a client_assertion being reused.
async function jtiBrukt(jti: string): Promise<boolean> {
	const row = await one<{ n: string }>(
		"SELECT 1 AS n FROM oauth_token WHERE token_hash = $1 AND kind = 'jti' AND tenant_id = $2 AND expires_at > now()",
		[tokenHash(jti), requireTenant().id]
	);
	return row !== null;
}

async function storeJti(jti: string, exp: number): Promise<void> {
	await exec(
		`INSERT INTO oauth_token (id, tenant_id, kind, token_hash, client_id, scope, familie, expires_at)
		 VALUES ($1,$4,'jti',$2,'-','',$1,to_timestamp($3)) ON CONFLICT (token_hash) DO NOTHING`,
		[newId(), tokenHash(jti), exp, requireTenant().id]
	);
}
