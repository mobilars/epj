import { createHash } from 'node:crypto';
import { en, exec } from '../db';
import { config } from '../config';
import { tokenHash } from '../util/crypto';
import { nyId, nyToken } from '../util/ids';
import { aktivSigneringsnokkel, jwks } from './keys';
import { signer, verifiser } from './jws';
import { parseScopes } from '../authz/scopes';
import type { AuthContext, LaunchKontekst } from '../authz/context';
import { rettigheterForRoller, type Rolle } from '../authz/roles';
import { rollerFor, hentBruker } from './brukere';

export interface UtstedtToken {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	scope: string;
	refresh_token?: string;
	id_token?: string;
	patient?: string;
	encounter?: string;
	need_patient_banner?: boolean;
	smart_style_url?: string;
	fhirUser?: string;
	[key: string]: unknown;
}

export interface UtstedelseInn {
	clientId: string;
	userId: string | null;
	scope: string;
	launch: LaunchKontekst;
	/** Utsted refresh token (krever `offline_access` eller `online_access`). */
	medRefresh: boolean;
	nonce?: string | null;
}

/**
 * Utsteder access token som signert JWT (ES256).
 *
 * Tokenet er selvbeskrivende slik at ressursserveren kan validere det uten
 * databaseoppslag, men vi lagrer likevel en hash av det: uten det kan vi ikke
 * trekke tilbake tokens ved mistanke om misbruk, og tilbakekalling er et krav
 * i Normen ved avslutning av arbeidsforhold.
 */
export async function utstedTokens(inn: UtstedelseInn): Promise<UtstedtToken> {
	const nokkel = await aktivSigneringsnokkel();
	const nå = Math.floor(Date.now() / 1000);
	const jti = nyId();
	const familie = nyId();

	const roller = inn.userId ? await rollerFor(inn.userId) : [];
	const bruker = inn.userId ? await hentBruker(inn.userId) : null;
	const fhirUser = bruker?.practitioner_id
		? `${config.fhirBaseUrl}/Practitioner/${bruker.practitioner_id}`
		: undefined;

	const payload = {
		iss: config.issuer,
		sub: inn.userId ?? inn.clientId,
		aud: config.fhirBaseUrl,
		client_id: inn.clientId,
		scope: inn.scope,
		jti,
		iat: nå,
		exp: nå + config.oauth.accessTokenTtl,
		...(roller.length ? { roles: roller } : {}),
		...(inn.launch.patientId ? { patient: inn.launch.patientId } : {}),
		...(inn.launch.encounterId ? { encounter: inn.launch.encounterId } : {}),
		...(fhirUser ? { fhirUser } : {})
	};
	const accessToken = signer(payload, nokkel.privatePem, nokkel.kid, 'at+jwt');

	await exec(
		`INSERT INTO oauth_token (id, kind, token_hash, client_id, user_id, scope, launch_context, familie, utloper)
		 VALUES ($1,'access',$2,$3,$4,$5,$6,$7,to_timestamp($8))`,
		[jti, tokenHash(accessToken), inn.clientId, inn.userId, inn.scope, JSON.stringify(inn.launch), familie, payload.exp]
	);

	const resultat: UtstedtToken = {
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: config.oauth.accessTokenTtl,
		scope: inn.scope
	};

	if (inn.medRefresh) {
		resultat.refresh_token = await utstedRefreshToken(inn, familie);
	}

	// SMART launch-parametere returneres sammen med tokenet.
	if (inn.launch.patientId) resultat.patient = inn.launch.patientId;
	if (inn.launch.encounterId) resultat.encounter = inn.launch.encounterId;
	if (fhirUser) resultat.fhirUser = fhirUser;
	resultat.need_patient_banner = !inn.launch.patientId;
	resultat.smart_style_url = `${config.baseUrl}/smart-style.json`;

	if (inn.scope.split(/\s+/).includes('openid') && inn.userId) {
		resultat.id_token = signer(
			{
				iss: config.issuer,
				sub: inn.userId,
				aud: inn.clientId,
				iat: nå,
				exp: nå + config.oauth.accessTokenTtl,
				...(inn.nonce ? { nonce: inn.nonce } : {}),
				name: bruker?.navn,
				...(fhirUser ? { fhirUser } : {}),
				...(roller.length ? { roles: roller } : {})
			},
			nokkel.privatePem,
			nokkel.kid
		);
	}

	return resultat;
}

async function utstedRefreshToken(inn: UtstedelseInn, familie: string): Promise<string> {
	const token = nyToken(48);
	await exec(
		`INSERT INTO oauth_token (id, kind, token_hash, client_id, user_id, scope, launch_context, familie, utloper)
		 VALUES ($1,'refresh',$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)`,
		[nyId(), tokenHash(token), inn.clientId, inn.userId, inn.scope, JSON.stringify(inn.launch), familie, String(config.oauth.refreshTokenTtl)]
	);
	return token;
}

export interface RefreshResultat {
	ok: boolean;
	feil?: string;
	tokens?: UtstedtToken;
}

/**
 * Bytter inn et refresh token. Tokenet roteres, og gjenbruk av et allerede
 * innbyttet token tolkes som tyveri: hele token-familien trekkes tilbake.
 */
export async function fornyMedRefreshToken(refreshToken: string, clientId: string, nyttScope?: string): Promise<RefreshResultat> {
	const hash = tokenHash(refreshToken);
	const rad = await en<{
		id: string; client_id: string; user_id: string | null; scope: string;
		launch_context: LaunchKontekst; familie: string; tilbakekalt: boolean; utloper: string;
	}>(
		`SELECT id, client_id, user_id, scope, launch_context, familie, tilbakekalt, utloper
		 FROM oauth_token WHERE token_hash = $1 AND kind = 'refresh'`,
		[hash]
	);
	if (!rad) return { ok: false, feil: 'Ukjent refresh token' };
	if (rad.client_id !== clientId) return { ok: false, feil: 'Tokenet tilhører en annen klient' };
	if (rad.tilbakekalt) {
		await exec("UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = 'gjenbruk av refresh token' WHERE familie = $1", [rad.familie]);
		return { ok: false, feil: 'Tokenet er allerede brukt - hele sesjonen er trukket tilbake' };
	}
	if (new Date(rad.utloper).getTime() <= Date.now()) return { ok: false, feil: 'Refresh token er utløpt' };

	if (config.oauth.rotateRefreshTokens) {
		await exec("UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = 'rotert' WHERE id = $1", [rad.id]);
	}

	// Scope kan snevres inn, aldri utvides.
	const opprinnelige = new Set(rad.scope.split(/\s+/));
	const scope = nyttScope
		? nyttScope.split(/\s+/).filter((s) => opprinnelige.has(s)).join(' ')
		: rad.scope;

	const tokens = await utstedTokens({
		clientId, userId: rad.user_id, scope,
		launch: rad.launch_context ?? {},
		medRefresh: true
	});
	return { ok: true, tokens };
}

export async function tilbakekallToken(token: string, clientId: string): Promise<boolean> {
	const n = await exec(
		"UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = 'revocation endpoint' WHERE token_hash = $1 AND client_id = $2",
		[tokenHash(token), clientId]
	);
	return n > 0;
}

export async function tilbakekallForBruker(userId: string, grunn: string): Promise<number> {
	return exec('UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = $2 WHERE user_id = $1 AND tilbakekalt = false', [userId, grunn]);
}

export interface TokenValidering {
	gyldig: boolean;
	feil?: string;
	ctx?: Omit<AuthContext, 'ip' | 'requestId'>;
	payload?: Record<string, unknown>;
}

/** Validerer et Bearer-token og bygger tilgangskonteksten. */
export async function validerAccessToken(token: string): Promise<TokenValidering> {
	let payload: Record<string, unknown>;
	try {
		payload = verifiser(token, (await jwks()).keys) as Record<string, unknown>;
	} catch (err) {
		return { gyldig: false, feil: (err as Error).message };
	}
	if (payload.iss !== config.issuer) return { gyldig: false, feil: 'Ugyldig utsteder' };

	const rad = await en<{ tilbakekalt: boolean; user_id: string | null; launch_context: LaunchKontekst; client_id: string }>(
		"SELECT tilbakekalt, user_id, launch_context, client_id FROM oauth_token WHERE token_hash = $1 AND kind = 'access'",
		[tokenHash(token)]
	);
	if (!rad) return { gyldig: false, feil: 'Tokenet er ukjent' };
	if (rad.tilbakekalt) return { gyldig: false, feil: 'Tokenet er trukket tilbake' };

	const userId = rad.user_id;
	const roller: Rolle[] = userId ? await rollerFor(userId) : [];
	const bruker = userId ? await hentBruker(userId) : null;
	const scope = String(payload.scope ?? '');
	const launch = rad.launch_context ?? {};

	// Backend-tjenester har ingen bruker; rettighetene styres da av scope alene,
	// og de kan aldri få `patient/`-scope.
	const rettigheter = userId
		? rettigheterForRoller(roller)
		: new Set<never>(['journal:les', 'journal:skriv'] as never[]);

	return {
		gyldig: true,
		payload,
		ctx: {
			mate: userId ? 'smart-app' : 'backend-service',
			userId,
			actorRef: bruker?.practitioner_id ? `Practitioner/${bruker.practitioner_id}` : `Device/${rad.client_id}`,
			navn: bruker?.navn ?? `Systemklient ${rad.client_id}`,
			roller,
			rettigheter: rettigheter as never,
			scopes: parseScopes(scope),
			clientId: rad.client_id,
			clientNavn: null,
			launch,
			sessionId: null,
			tokenId: String(payload.jti ?? ''),
			amr: userId ? 'delegert' : 'client_credentials',
			elevertTil: null
		}
	};
}

/** RFC 7662 token introspection. */
export async function introspiser(token: string): Promise<Record<string, unknown>> {
	const validering = await validerAccessToken(token);
	if (!validering.gyldig || !validering.payload) return { active: false };
	const p = validering.payload;
	return {
		active: true,
		scope: p.scope,
		client_id: p.client_id,
		sub: p.sub,
		exp: p.exp,
		iat: p.iat,
		iss: p.iss,
		aud: p.aud,
		token_type: 'Bearer',
		...(p.patient ? { patient: p.patient } : {}),
		...(p.fhirUser ? { fhirUser: p.fhirUser } : {})
	};
}

export async function ryddUtlopteTokens(): Promise<number> {
	return exec("DELETE FROM oauth_token WHERE utloper < now() - interval '7 days'");
}

/** S256 code challenge for PKCE. */
export function pkceUtfordring(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}
