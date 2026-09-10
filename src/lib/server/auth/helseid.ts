import { randomBytes, createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { config } from '../config';
import { decrypt, encrypt } from '../util/crypto';
import { newId } from '../util/ids';
import { sign, verify, type Algoritme, type Jwk } from './jws';
import { one, exec, transaction } from '../db';
import { requireTenant, issuerFor } from '../tenant/context';
import { createUser, getUser, rolesFor, type User } from './users';
import type { Role } from '../authz/roles';

/**
 * HelseID som identitetsleverandør.
 *
 * HelseID er den nasjonale påloggingstjenesten for helsepersonell, driftet av
 * Norsk helsenett. Journalen opptrer som en OIDC-klient med
 * autorisasjonskodeflyt, PKCE og `private_key_jwt` - ingen delt hemmelighet
 * ligger i konfigurasjonen.
 *
 * Fra id_token/userinfo henter vi:
 *   - `helseid://claims/identity/pid`            fødselsnummer (personidentifikator)
 *   - `helseid://claims/hpr/hpr_number`          HPR-nummer
 *   - `helseid://claims/identity/security_level` sikkerhetsnivå (4 kreves)
 *   - `name`                                     navn
 *
 * Brukere provisjoneres ved første pålogging, men får ingen roller automatisk:
 * rolletildeling er en administrativ handling som skal etterlate spor.
 *
 * Koblingen er per virksomhet. Samme lege kan arbeide ved flere legekontorer,
 * og skal da ha én brukerkonto i hver - med hver sine roller og relasjoner.
 */

export const CLAIM = {
	PID: 'helseid://claims/identity/pid',
	PID_PSEUDONYM: 'helseid://claims/identity/pid_pseudonym',
	SECURITY_LEVEL: 'helseid://claims/identity/security_level',
	HPR_NUMBER: 'helseid://claims/hpr/hpr_number',
	ASSURANCE_LEVEL: 'helseid://claims/identity/assurance_level',
	ORGNR_PARENT: 'helseid://claims/client/claims/orgnr_parent'
} as const;

interface Metadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	userinfo_endpoint?: string;
	end_session_endpoint?: string;
}

let metadataCache: { value: Metadata; to: number } | null = null;
let jwksCache: { value: Jwk[]; to: number } | null = null;

export async function getMetadata(): Promise<Metadata> {
	if (metadataCache && Date.now() < metadataCache.to) return metadataCache.value;
	const url = `${config.integrations.healthId.issuer}/.well-known/openid-configuration`;
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`Klarte ikke å hente HelseID-metadata (${response.status})`);
	const value = (await response.json()) as Metadata;
	metadataCache = { value, to: Date.now() + 3600_000 };
	return value;
}

async function getJwks(): Promise<Jwk[]> {
	if (jwksCache && Date.now() < jwksCache.to) return jwksCache.value;
	const meta = await getMetadata();
	const response = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`Klarte ikke å hente HelseID-nøkler (${response.status})`);
	const jwks = (await response.json()) as { keys: Jwk[] };
	jwksCache = { value: jwks.keys, to: Date.now() + 3600_000 };
	return jwks.keys;
}

const STATE_COOKIE = 'epj_helseid';

interface FlowState {
	state: string;
	nonce: string;
	codeVerifier: string;
	returnTo: string;
	created_at: number;
}

/** Bygger autorisasjons-URL og legger flyttilstanden i en kryptert cookie. */
export async function startLogin(cookies: Cookies, returnTo: string): Promise<string> {
	const meta = await getMetadata();
	const state = randomBytes(24).toString('base64url');
	const nonce = randomBytes(24).toString('base64url');
	const codeVerifier = randomBytes(48).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

	const flowState: FlowState = { state, nonce, codeVerifier, returnTo, created_at: Date.now() };
	cookies.set(STATE_COOKIE, encrypt(JSON.stringify(flowState)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax', // må overleve omdirigering tilbake fra HelseID
		secure: config.security.httpsOnly,
		maxAge: 600
	});

	const url = new URL(meta.authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', config.integrations.healthId.clientId);
	url.searchParams.set('redirect_uri', redirectUri());
	url.searchParams.set('scope', config.integrations.healthId.scopes.join(' '));
	url.searchParams.set('state', state);
	url.searchParams.set('nonce', nonce);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

export function redirectUri(): string {
	// Tilbakekallsadressen må ligge på virksomhetens eget vertsnavn, siden
	// sesjonen opprettes der.
	return config.integrations.healthId.redirectUri || `${issuerFor(requireTenant())}/logg-inn/helseid/tilbake`;
}

function readState(cookies: Cookies): FlowState | null {
	const raw = cookies.get(STATE_COOKIE);
	if (!raw) return null;
	try {
		const t = JSON.parse(decrypt(raw)) as FlowState;
		if (Date.now() - t.created_at > 600_000) return null;
		return t;
	} catch {
		return null;
	}
}

export function endFlow(cookies: Cookies): void {
	cookies.delete(STATE_COOKIE, { path: '/' });
}

/** Klientassertion (private_key_jwt) mot HelseID sitt token-endepunkt. */
function clientAssertion(tokenEndpoint: string): string {
	const { clientId, privateKeyPem, keyId, signeringsalgoritme } = config.integrations.healthId;
	if (!privateKeyPem) throw new Error('HelseID-klientnøkkel mangler (EPJ_HELSEID_PRIVATE_KEY)');
	const now = Math.floor(Date.now() / 1000);
	return sign(
		{ iss: clientId, sub: clientId, aud: tokenEndpoint, jti: newId(), iat: now, nbf: now, exp: now + 60 },
		privateKeyPem,
		keyId,
		'JWT',
		signeringsalgoritme as Algoritme
	);
}

export interface HealthIdRequirement {
	sub: string;
	name: string;
	pid: string | null;
	hprNumber: string | null;
	sikkerhetsniva: string | null;
	raw: Record<string, unknown>;
}

export type PaloggingsResult =
	| { ok: true; requirement: HealthIdRequirement; returnTo: string; user: User; roles: Role[]; newUser: boolean }
	| { ok: false; error: string };

/**
 * Fullfører flyten: bytter koden mot tokens, verifiserer id_token og
 * kobler eller oppretter den lokale brukeren.
 */
export async function fullforLogin(
	cookies: Cookies,
	code: string,
	state: string
): Promise<PaloggingsResult> {
	const flowState = readState(cookies);
	endFlow(cookies);
	if (!flowState) return { ok: false, error: 'Påloggingen tok for lang tid. Prøv igjen.' };
	if (flowState.state !== state) return { ok: false, error: 'Ugyldig state - påloggingen ble avbrutt av sikkerhetshensyn.' };

	const meta = await getMetadata();
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: code,
		redirect_uri: redirectUri(),
		client_id: config.integrations.healthId.clientId,
		code_verifier: flowState.codeVerifier,
		client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		client_assertion: clientAssertion(meta.token_endpoint)
	});

	const response = await fetch(meta.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body,
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) {
		return { ok: false, error: `HelseID avviste innloggingen (${response.status})` };
	}
	const tokens = (await response.json()) as { id_token?: string; access_token?: string };
	if (!tokens.id_token) return { ok: false, error: 'HelseID returnerte ikke id_token' };

	let requirement: Record<string, unknown>;
	try {
		requirement = verify(tokens.id_token, await getJwks()) as Record<string, unknown>;
	} catch (err) {
		return { ok: false, error: `Kunne ikke verifisere id_token: ${(err as Error).message}` };
	}
	if (requirement.iss !== config.integrations.healthId.issuer) return { ok: false, error: 'Feil utsteder i id_token' };
	const aud = Array.isArray(requirement.aud) ? requirement.aud : [requirement.aud];
	if (!aud.includes(config.integrations.healthId.clientId)) return { ok: false, error: 'id_token er utstedt til en annen klient' };
	if (requirement.nonce !== flowState.nonce) return { ok: false, error: 'Nonce stemmer ikke - mulig gjenspillingsforsøk' };

	const sikkerhetsniva = (requirement[CLAIM.SECURITY_LEVEL] as string) ?? null;
	if (sikkerhetsniva && sikkerhetsniva !== '4') {
		return { ok: false, error: `Innlogging krever sikkerhetsnivå 4 (fikk ${sikkerhetsniva})` };
	}

	const parsed: HealthIdRequirement = {
		sub: String(requirement.sub),
		name: (requirement.name as string) ?? 'Ukjent',
		pid: (requirement[CLAIM.PID] as string) ?? null,
		hprNumber: (requirement[CLAIM.HPR_NUMBER] as string) ?? null,
		sikkerhetsniva,
		raw: requirement
	};

	const { user, roles, newUser } = await kobleOnLokalUser(parsed);
	return { ok: true, requirement: parsed, returnTo: flowState.returnTo, user, roles, newUser };
}

/**
 * Finner den lokale brukeren for en HelseID-identitet, eller oppretter den.
 *
 * Kobling skjer på `sub` (stabil i HelseID) og sekundært på HPR-nummer, slik at
 * en bruker som er forhåndsregistrert av systemansvarlig kobles automatisk ved
 * første pålogging. Nye brukere opprettes uten roller og uten tilgang.
 */
export async function kobleOnLokalUser(
	requirement: HealthIdRequirement
): Promise<{ user: User; roles: Role[]; newUser: boolean }> {
	return transaction(async () => {
		const tenantId = requireTenant().id;
		let row = await one<{ id: string }>(
			'SELECT id FROM user_account WHERE helseid_sub = $1 AND tenant_id = $2',
			[requirement.sub, tenantId]
		);

		if (!row && requirement.hprNumber) {
			row = await one<{ id: string }>(
				'SELECT id FROM user_account WHERE hpr_number = $1 AND tenant_id = $2 AND helseid_sub IS NULL',
				[requirement.hprNumber, tenantId]
			);
			if (row) {
				await exec('UPDATE user_account SET helseid_sub = $2, name = $3, updated_at = now() WHERE id = $1', [row.id, requirement.sub, requirement.name]);
			}
		}

		if (row) {
			await exec('UPDATE user_account SET last_login = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1', [row.id]);
			const user = await getUser(row.id);
			if (!user) throw new Error('Fant ikke brukeren etter kobling');
			return { user, roles: await rolesFor(user.id), newUser: false };
		}

		const username = requirement.hprNumber ? `hpr-${requirement.hprNumber}` : `helseid-${requirement.sub.slice(0, 12)}`;
		const user = await createUser({
			username,
			name: requirement.name,
			hprNumber: requirement.hprNumber ?? undefined,
			roles: [] // roller tildeles av systemansvarlig
		});
		await exec('UPDATE user_account SET helseid_sub = $2, must_change_password = false, last_login = now() WHERE id = $1', [user.id, requirement.sub]);
		const updated_at = await getUser(user.id);
		return { user: updated_at ?? user, roles: [], newUser: true };
	});
}

export function isKonfigurert(): boolean {
	const h = config.integrations.healthId;
	return h.enabled && Boolean(h.clientId) && Boolean(h.privateKeyPem);
}
