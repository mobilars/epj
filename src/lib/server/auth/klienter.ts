import { en, exec, query } from '../db';
import { hashPassord, likeStrenger, tokenHash, verifiserPassord } from '../util/crypto';
import { nyId, nyToken } from '../util/ids';
import { verifiser as verifiserJws, dekodUtenVerifisering, type Jwk } from './jws';
import { config } from '../config';

export type Klientkategori = 'smart-ehr' | 'smart-standalone' | 'backend' | 'internal';

export interface OAuthKlient {
	client_id: string;
	navn: string;
	type: 'public' | 'confidential';
	klient_kategori: Klientkategori;
	secret_hash: string | null;
	jwks: { keys: Jwk[] } | null;
	jwks_uri: string | null;
	redirect_uris: string[];
	tillatte_scopes: string[];
	grant_types: string[];
	krev_pkce: boolean;
	krev_samtykke: boolean;
	logo_url: string | null;
	databehandleravtale: string | null;
	status: string;
	opprettet: string;
}

const FELT = `client_id, navn, type, klient_kategori, secret_hash, jwks, jwks_uri, redirect_uris,
	tillatte_scopes, grant_types, krev_pkce, krev_samtykke, logo_url, databehandleravtale, status, opprettet`;

export async function hentKlient(clientId: string): Promise<OAuthKlient | null> {
	return en<OAuthKlient>(`SELECT ${FELT} FROM oauth_client WHERE client_id = $1`, [clientId]);
}

export async function listKlienter(): Promise<OAuthKlient[]> {
	return query<OAuthKlient>(`SELECT ${FELT} FROM oauth_client ORDER BY navn`);
}

export interface NyKlient {
	navn: string;
	type: 'public' | 'confidential';
	kategori: Klientkategori;
	redirectUris: string[];
	scopes: string[];
	grantTypes?: string[];
	jwks?: { keys: Jwk[] };
	jwksUri?: string;
	logoUrl?: string;
	databehandleravtale?: string;
	opprettetAv?: string;
}

export async function registrerKlient(inn: NyKlient): Promise<{ klient: OAuthKlient; secret?: string }> {
	const clientId = `epj-${nyId()}`;
	const secret = inn.type === 'confidential' && !inn.jwks && !inn.jwksUri ? nyToken(32) : undefined;
	await exec(
		`INSERT INTO oauth_client (client_id, navn, type, klient_kategori, secret_hash, jwks, jwks_uri,
			redirect_uris, tillatte_scopes, grant_types, krev_pkce, logo_url, databehandleravtale, opprettet_av)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		[
			clientId, inn.navn, inn.type, inn.kategori, secret ? hashPassord(secret) : null,
			inn.jwks ? JSON.stringify(inn.jwks) : null, inn.jwksUri ?? null,
			JSON.stringify(inn.redirectUris), JSON.stringify(inn.scopes),
			JSON.stringify(inn.grantTypes ?? (inn.kategori === 'backend' ? ['client_credentials'] : ['authorization_code', 'refresh_token'])),
			inn.type === 'public', inn.logoUrl ?? null, inn.databehandleravtale ?? null, inn.opprettetAv ?? null
		]
	);
	const klient = await hentKlient(clientId);
	if (!klient) throw new Error('Klarte ikke å registrere klienten');
	return { klient, secret };
}

export async function settKlientstatus(clientId: string, status: 'aktiv' | 'sperret'): Promise<void> {
	await exec('UPDATE oauth_client SET status = $2 WHERE client_id = $1', [clientId, status]);
	if (status === 'sperret') {
		await exec("UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = 'klient sperret' WHERE client_id = $1", [clientId]);
	}
}

/** Eksakt sammenlikning av redirect_uri, uten mønstertolkning (OAuth 2.1). */
export function gyldigRedirectUri(klient: OAuthKlient, uri: string): boolean {
	return klient.redirect_uris.some((r) => likeStrenger(r, uri));
}

export type KlientAutentisering =
	| { ok: true; klient: OAuthKlient; metode: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' }
	| { ok: false; feil: string };

/**
 * Autentiserer klienten på token-endepunktet.
 *
 * For tjeneste-til-tjeneste-tilgang (SMART Backend Services) er `private_key_jwt`
 * påkrevd - det er også kravet i HelseID for virksomhetssertifikat-baserte
 * integrasjoner, og gjør at ingen delt hemmelighet trenger å ligge hos klienten.
 */
export async function autentiserKlient(
	form: URLSearchParams,
	authorizationHeader: string | null
): Promise<KlientAutentisering> {
	let clientId = form.get('client_id') ?? undefined;
	let clientSecret: string | undefined;
	let metode: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' = 'none';

	if (authorizationHeader?.toLowerCase().startsWith('basic ')) {
		const dekodet = Buffer.from(authorizationHeader.slice(6), 'base64').toString('utf8');
		const skille = dekodet.indexOf(':');
		clientId = decodeURIComponent(dekodet.slice(0, skille));
		clientSecret = decodeURIComponent(dekodet.slice(skille + 1));
		metode = 'client_secret_basic';
	} else if (form.get('client_secret')) {
		clientSecret = form.get('client_secret') ?? undefined;
		metode = 'client_secret_post';
	}

	const assertion = form.get('client_assertion');
	const assertionType = form.get('client_assertion_type');
	if (assertion && assertionType === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
		const dekodet = dekodUtenVerifisering(assertion);
		clientId = clientId ?? (dekodet?.payload.sub as string | undefined);
		metode = 'private_key_jwt';
	}

	if (!clientId) return { ok: false, feil: 'client_id mangler' };
	const klient = await hentKlient(clientId);
	if (!klient) return { ok: false, feil: 'Ukjent klient' };
	if (klient.status !== 'aktiv') return { ok: false, feil: 'Klienten er sperret' };

	if (metode === 'private_key_jwt') {
		const nokler = await klientNokler(klient);
		if (nokler.length === 0) return { ok: false, feil: 'Klienten har ingen registrerte nøkler' };
		try {
			const payload = verifiserJws(assertion as string, nokler);
			if (payload.iss !== clientId || payload.sub !== clientId) return { ok: false, feil: 'Ugyldig iss/sub i client_assertion' };
			const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
			if (!aud.includes(`${config.baseUrl}/oauth/token`) && !aud.includes(config.issuer)) {
				return { ok: false, feil: 'Ugyldig aud i client_assertion' };
			}
			if (typeof payload.jti !== 'string' || await jtiBrukt(payload.jti)) {
				return { ok: false, feil: 'client_assertion mangler jti eller er gjenbrukt' };
			}
			await lagreJti(payload.jti, payload.exp ?? Math.floor(Date.now() / 1000) + 300);
		} catch (err) {
			return { ok: false, feil: `Ugyldig client_assertion: ${(err as Error).message}` };
		}
		return { ok: true, klient, metode };
	}

	if (klient.type === 'confidential') {
		if (!clientSecret || !klient.secret_hash || !verifiserPassord(clientSecret, klient.secret_hash)) {
			return { ok: false, feil: 'Ugyldig klienthemmelighet' };
		}
		return { ok: true, klient, metode };
	}

	// Offentlige klienter autentiseres ikke; PKCE er da påkrevd.
	return { ok: true, klient, metode: 'none' };
}

async function klientNokler(klient: OAuthKlient): Promise<Jwk[]> {
	if (klient.jwks?.keys?.length) return klient.jwks.keys;
	if (!klient.jwks_uri) return [];
	try {
		const svar = await fetch(klient.jwks_uri, { signal: AbortSignal.timeout(5000) });
		if (!svar.ok) return [];
		const jwks = (await svar.json()) as { keys?: Jwk[] };
		return jwks.keys ?? [];
	} catch {
		return [];
	}
}

// jti-er lagres kortvarig for å hindre gjenbruk av client_assertion.
async function jtiBrukt(jti: string): Promise<boolean> {
	const rad = await en<{ n: string }>(
		"SELECT 1 AS n FROM oauth_token WHERE token_hash = $1 AND kind = 'jti' AND utloper > now()",
		[tokenHash(jti)]
	);
	return rad !== null;
}

async function lagreJti(jti: string, exp: number): Promise<void> {
	await exec(
		`INSERT INTO oauth_token (id, kind, token_hash, client_id, scope, familie, utloper)
		 VALUES ($1,'jti',$2,'-','',$1,to_timestamp($3)) ON CONFLICT (token_hash) DO NOTHING`,
		[nyId(), tokenHash(jti), exp]
	);
}
