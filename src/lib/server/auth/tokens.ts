import { createHash } from 'node:crypto';
import { one, exec } from '../db';
import { requireTenant, issuerFor, fhirBaseFor } from '../tenant/context';
import { config } from '../config';
import { tokenHash } from '../util/crypto';
import { newId, newToken } from '../util/ids';
import { activeSigningKey, jwks } from './keys';
import { sign, verify } from './jws';
import { parseScopes } from '../authz/scopes';
import type { AuthContext, LaunchContext } from '../authz/context';
import { permissionsForRoles, type Role } from '../authz/roles';
import { rolesFor, getUser } from './users';

export interface IssuedToken {
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

export interface UtstedelseIn {
	clientId: string;
	userId: string | null;
	scope: string;
	launch: LaunchContext;
	/** Utsted refresh token (krever `offline_access` eller `online_access`). */
	withRefresh: boolean;
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
export async function issueTokens(inValue: UtstedelseIn): Promise<IssuedToken> {
	const tenant = requireTenant();
	const key = await activeSigningKey();
	const now = Math.floor(Date.now() / 1000);
	const jti = newId();
	const familie = newId();

	const roles = inValue.userId ? await rolesFor(inValue.userId) : [];
	const user = inValue.userId ? await getUser(inValue.userId) : null;
	const fhirUser = user?.practitioner_id
		? `${fhirBaseFor(tenant)}/Practitioner/${user.practitioner_id}`
		: undefined;

	const payload = {
		iss: issuerFor(tenant),
		sub: inValue.userId ?? inValue.clientId,
		aud: fhirBaseFor(tenant),
		// Virksomheten tokenet gjelder. Kontrolleres ved validering, slik at et
		// token fra én virksomhet ikke kan brukes mot en annen.
		tenant: tenant.id,
		client_id: inValue.clientId,
		scope: inValue.scope,
		jti,
		iat: now,
		exp: now + config.oauth.accessTokenTtl,
		...(roles.length ? { roles: roles } : {}),
		...(inValue.launch.patientId ? { patient: inValue.launch.patientId } : {}),
		...(inValue.launch.encounterId ? { encounter: inValue.launch.encounterId } : {}),
		...(fhirUser ? { fhirUser } : {})
	};
	const accessToken = sign(payload, key.privatePem, key.kid, 'at+jwt');

	await exec(
		`INSERT INTO oauth_token (id, tenant_id, kind, token_hash, client_id, user_id, scope, launch_context, familie, expires_at)
		 VALUES ($1,$9,'access',$2,$3,$4,$5,$6,$7,to_timestamp($8))`,
		[jti, tokenHash(accessToken), inValue.clientId, inValue.userId, inValue.scope, JSON.stringify(inValue.launch), familie, payload.exp, tenant.id]
	);

	const result: IssuedToken = {
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: config.oauth.accessTokenTtl,
		scope: inValue.scope
	};

	if (inValue.withRefresh) {
		result.refresh_token = await issueRefreshToken(inValue, familie);
	}

	// SMART launch-parametere returneres sammen med tokenet.
	if (inValue.launch.patientId) result.patient = inValue.launch.patientId;
	if (inValue.launch.encounterId) result.encounter = inValue.launch.encounterId;
	if (fhirUser) result.fhirUser = fhirUser;
	result.need_patient_banner = !inValue.launch.patientId;
	result.smart_style_url = `${issuerFor(tenant)}/smart-style.json`;

	if (inValue.scope.split(/\s+/).includes('openid') && inValue.userId) {
		result.id_token = sign(
			{
				iss: issuerFor(tenant),
				sub: inValue.userId,
				aud: inValue.clientId,
				tenant: tenant.id,
				iat: now,
				exp: now + config.oauth.accessTokenTtl,
				...(inValue.nonce ? { nonce: inValue.nonce } : {}),
				name: user?.name,
				...(fhirUser ? { fhirUser } : {}),
				...(roles.length ? { roles: roles } : {})
			},
			key.privatePem,
			key.kid
		);
	}

	return result;
}

async function issueRefreshToken(inValue: UtstedelseIn, familie: string): Promise<string> {
	const token = newToken(48);
	await exec(
		`INSERT INTO oauth_token (id, tenant_id, kind, token_hash, client_id, user_id, scope, launch_context, familie, expires_at)
		 VALUES ($1,$9,'refresh',$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)`,
		[newId(), tokenHash(token), inValue.clientId, inValue.userId, inValue.scope, JSON.stringify(inValue.launch), familie, String(config.oauth.refreshTokenTtl), requireTenant().id]
	);
	return token;
}

export interface RefreshResult {
	ok: boolean;
	error?: string;
	tokens?: IssuedToken;
}

/**
 * Bytter inn et refresh token. Tokenet roteres, og gjenbruk av et allerede
 * innbyttet token tolkes som tyveri: hele token-familien trekkes tilbake.
 */
export async function renewWithRefreshToken(refreshToken: string, clientId: string, newScope?: string): Promise<RefreshResult> {
	const hash = tokenHash(refreshToken);
	const row = await one<{
		id: string; client_id: string; user_id: string | null; scope: string;
		launch_context: LaunchContext; familie: string; revoked: boolean; expires_at: string;
	}>(
		`SELECT id, client_id, user_id, scope, launch_context, familie, revoked, expires_at
		 FROM oauth_token WHERE token_hash = $1 AND kind = 'refresh' AND tenant_id = $2`,
		[hash, requireTenant().id]
	);
	if (!row) return { ok: false, error: 'Ukjent refresh token' };
	if (row.client_id !== clientId) return { ok: false, error: 'Tokenet tilhører en annen klient' };
	if (row.revoked) {
		await exec(
			"UPDATE oauth_token SET revoked = true, revoked_reason = 'gjenbruk av refresh token' WHERE familie = $1 AND tenant_id = $2",
			[row.familie, requireTenant().id]
		);
		return { ok: false, error: 'Tokenet er allerede brukt - hele sesjonen er trukket tilbake' };
	}
	if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, error: 'Refresh token er utløpt' };

	if (config.oauth.rotateRefreshTokens) {
		await exec("UPDATE oauth_token SET revoked = true, revoked_reason = 'rotert' WHERE id = $1 AND tenant_id = $2", [row.id, requireTenant().id]);
	}

	// Scope kan snevres inn, aldri utvides.
	const opprinnelige = new Set(row.scope.split(/\s+/));
	const scope = newScope
		? newScope.split(/\s+/).filter((s) => opprinnelige.has(s)).join(' ')
		: row.scope;

	const tokens = await issueTokens({
		clientId, userId: row.user_id, scope,
		launch: row.launch_context ?? {},
		withRefresh: true
	});
	return { ok: true, tokens };
}

export async function revokeToken(token: string, clientId: string): Promise<boolean> {
	const n = await exec(
		"UPDATE oauth_token SET revoked = true, revoked_reason = 'revocation endpoint' WHERE token_hash = $1 AND client_id = $2 AND tenant_id = $3",
		[tokenHash(token), clientId, requireTenant().id]
	);
	return n > 0;
}

export async function revokeForUser(userId: string, reason: string): Promise<number> {
	return exec(
		'UPDATE oauth_token SET revoked = true, revoked_reason = $2 WHERE user_id = $1 AND tenant_id = $3 AND revoked = false',
		[userId, reason, requireTenant().id]
	);
}

export interface TokenValidation {
	valid: boolean;
	error?: string;
	ctx?: Omit<AuthContext, 'ip' | 'requestId'>;
	payload?: Record<string, unknown>;
}

/** Validerer et Bearer-token og bygger tilgangskonteksten. */
export async function validateAccessToken(token: string): Promise<TokenValidation> {
	let payload: Record<string, unknown>;
	try {
		payload = verify(token, (await jwks()).keys) as Record<string, unknown>;
	} catch (err) {
		return { valid: false, error: (err as Error).message };
	}
	const tenant = requireTenant();
	if (payload.iss !== issuerFor(tenant)) return { valid: false, error: 'Ugyldig utsteder' };
	// Tokenet må være utstedt for virksomheten forespørselen gjelder.
	if (payload.tenant && payload.tenant !== tenant.id) {
		return { valid: false, error: 'Tokenet er utstedt for en annen virksomhet' };
	}

	const row = await one<{ revoked: boolean; user_id: string | null; launch_context: LaunchContext; client_id: string }>(
		"SELECT revoked, user_id, launch_context, client_id FROM oauth_token WHERE token_hash = $1 AND kind = 'access' AND tenant_id = $2",
		[tokenHash(token), tenant.id]
	);
	if (!row) return { valid: false, error: 'Tokenet er ukjent' };
	if (row.revoked) return { valid: false, error: 'Tokenet er trukket tilbake' };

	const userId = row.user_id;
	const roles: Role[] = userId ? await rolesFor(userId) : [];
	const user = userId ? await getUser(userId) : null;
	const scope = String(payload.scope ?? '');
	const launch = row.launch_context ?? {};

	// Backend-tjenester har ingen bruker; rettighetene styres da av scope alene,
	// og de kan aldri få `patient/`-scope.
	const permissions = userId
		? permissionsForRoles(roles)
		: new Set<never>(['journal:les', 'journal:skriv'] as never[]);

	return {
		valid: true,
		payload,
		ctx: {
			mate: userId ? 'smart-app' : 'backend-service',
			userId,
			actorRef: user?.practitioner_id ? `Practitioner/${user.practitioner_id}` : `Device/${row.client_id}`,
			name: user?.name ?? `Systemklient ${row.client_id}`,
			roles,
			permissions: permissions as never,
			scopes: parseScopes(scope),
			clientId: row.client_id,
			clientName: null,
			launch,
			sessionId: null,
			tokenId: String(payload.jti ?? ''),
			amr: userId ? 'delegert' : 'client_credentials',
			elevatedTo: null
		}
	};
}

/** RFC 7662 token introspection. */
export async function introspiser(token: string): Promise<Record<string, unknown>> {
	const validation = await validateAccessToken(token);
	if (!validation.valid || !validation.payload) return { active: false };
	const p = validation.payload;
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

/** Vedlikehold. Går bevisst på tvers av virksomheter: sletter bare utløpte rader. */
export async function purgeUtlopteTokens(): Promise<number> {
	return exec("DELETE FROM oauth_token WHERE expires_at < now() - interval '7 days'");
}

/** S256 code challenge for PKCE. */
export function pkceChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}
