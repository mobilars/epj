import { randomBytes, createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { config } from '../config';
import { dekrypter, krypter } from '../util/crypto';
import { nyId } from '../util/ids';
import { signer, verifiser, type Algoritme } from './jws';
import { en, exec, transaction } from '../db';
import { opprettBruker, hentBruker, rollerFor, type Bruker } from './brukere';
import type { Rolle } from '../authz/roles';

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

let metadataCache: { verdi: Metadata; til: number } | null = null;
let jwksCache: { verdi: JsonWebKey[]; til: number } | null = null;

export async function hentMetadata(): Promise<Metadata> {
	if (metadataCache && Date.now() < metadataCache.til) return metadataCache.verdi;
	const url = `${config.integrasjoner.helseId.issuer}/.well-known/openid-configuration`;
	const svar = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!svar.ok) throw new Error(`Klarte ikke å hente HelseID-metadata (${svar.status})`);
	const verdi = (await svar.json()) as Metadata;
	metadataCache = { verdi, til: Date.now() + 3600_000 };
	return verdi;
}

async function hentJwks(): Promise<JsonWebKey[]> {
	if (jwksCache && Date.now() < jwksCache.til) return jwksCache.verdi;
	const meta = await hentMetadata();
	const svar = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) });
	if (!svar.ok) throw new Error(`Klarte ikke å hente HelseID-nøkler (${svar.status})`);
	const jwks = (await svar.json()) as { keys: JsonWebKey[] };
	jwksCache = { verdi: jwks.keys, til: Date.now() + 3600_000 };
	return jwks.keys;
}

const STATE_COOKIE = 'epj_helseid';

interface Flyttilstand {
	state: string;
	nonce: string;
	codeVerifier: string;
	retur: string;
	opprettet: number;
}

/** Bygger autorisasjons-URL og legger flyttilstanden i en kryptert cookie. */
export async function startPalogging(cookies: Cookies, retur: string): Promise<string> {
	const meta = await hentMetadata();
	const state = randomBytes(24).toString('base64url');
	const nonce = randomBytes(24).toString('base64url');
	const codeVerifier = randomBytes(48).toString('base64url');
	const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

	const tilstand: Flyttilstand = { state, nonce, codeVerifier, retur, opprettet: Date.now() };
	cookies.set(STATE_COOKIE, krypter(JSON.stringify(tilstand)), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax', // må overleve omdirigering tilbake fra HelseID
		secure: config.security.httpsOnly,
		maxAge: 600
	});

	const url = new URL(meta.authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', config.integrasjoner.helseId.clientId);
	url.searchParams.set('redirect_uri', redirectUri());
	url.searchParams.set('scope', config.integrasjoner.helseId.scopes.join(' '));
	url.searchParams.set('state', state);
	url.searchParams.set('nonce', nonce);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

export function redirectUri(): string {
	return config.integrasjoner.helseId.redirectUri || `${config.baseUrl}/logg-inn/helseid/tilbake`;
}

function lesTilstand(cookies: Cookies): Flyttilstand | null {
	const rå = cookies.get(STATE_COOKIE);
	if (!rå) return null;
	try {
		const t = JSON.parse(dekrypter(rå)) as Flyttilstand;
		if (Date.now() - t.opprettet > 600_000) return null;
		return t;
	} catch {
		return null;
	}
}

export function avsluttFlyt(cookies: Cookies): void {
	cookies.delete(STATE_COOKIE, { path: '/' });
}

/** Klientassertion (private_key_jwt) mot HelseID sitt token-endepunkt. */
function klientAssertion(tokenEndpoint: string): string {
	const { clientId, privateKeyPem, keyId, signeringsalgoritme } = config.integrasjoner.helseId;
	if (!privateKeyPem) throw new Error('HelseID-klientnøkkel mangler (EPJ_HELSEID_PRIVATE_KEY)');
	const nå = Math.floor(Date.now() / 1000);
	return signer(
		{ iss: clientId, sub: clientId, aud: tokenEndpoint, jti: nyId(), iat: nå, nbf: nå, exp: nå + 60 },
		privateKeyPem,
		keyId,
		'JWT',
		signeringsalgoritme as Algoritme
	);
}

export interface HelseIdKrav {
	sub: string;
	navn: string;
	pid: string | null;
	hprNummer: string | null;
	sikkerhetsniva: string | null;
	rå: Record<string, unknown>;
}

export type PaloggingsResultat =
	| { ok: true; krav: HelseIdKrav; retur: string; bruker: Bruker; roller: Rolle[]; nyBruker: boolean }
	| { ok: false; feil: string };

/**
 * Fullfører flyten: bytter koden mot tokens, verifiserer id_token og
 * kobler eller oppretter den lokale brukeren.
 */
export async function fullforPalogging(
	cookies: Cookies,
	kode: string,
	state: string
): Promise<PaloggingsResultat> {
	const tilstand = lesTilstand(cookies);
	avsluttFlyt(cookies);
	if (!tilstand) return { ok: false, feil: 'Påloggingen tok for lang tid. Prøv igjen.' };
	if (tilstand.state !== state) return { ok: false, feil: 'Ugyldig state - påloggingen ble avbrutt av sikkerhetshensyn.' };

	const meta = await hentMetadata();
	const kropp = new URLSearchParams({
		grant_type: 'authorization_code',
		code: kode,
		redirect_uri: redirectUri(),
		client_id: config.integrasjoner.helseId.clientId,
		code_verifier: tilstand.codeVerifier,
		client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		client_assertion: klientAssertion(meta.token_endpoint)
	});

	const svar = await fetch(meta.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: kropp,
		signal: AbortSignal.timeout(15_000)
	});
	if (!svar.ok) {
		return { ok: false, feil: `HelseID avviste innloggingen (${svar.status})` };
	}
	const tokens = (await svar.json()) as { id_token?: string; access_token?: string };
	if (!tokens.id_token) return { ok: false, feil: 'HelseID returnerte ikke id_token' };

	let krav: Record<string, unknown>;
	try {
		krav = verifiser(tokens.id_token, await hentJwks()) as Record<string, unknown>;
	} catch (err) {
		return { ok: false, feil: `Kunne ikke verifisere id_token: ${(err as Error).message}` };
	}
	if (krav.iss !== config.integrasjoner.helseId.issuer) return { ok: false, feil: 'Feil utsteder i id_token' };
	const aud = Array.isArray(krav.aud) ? krav.aud : [krav.aud];
	if (!aud.includes(config.integrasjoner.helseId.clientId)) return { ok: false, feil: 'id_token er utstedt til en annen klient' };
	if (krav.nonce !== tilstand.nonce) return { ok: false, feil: 'Nonce stemmer ikke - mulig gjenspillingsforsøk' };

	const sikkerhetsniva = (krav[CLAIM.SECURITY_LEVEL] as string) ?? null;
	if (sikkerhetsniva && sikkerhetsniva !== '4') {
		return { ok: false, feil: `Innlogging krever sikkerhetsnivå 4 (fikk ${sikkerhetsniva})` };
	}

	const parsed: HelseIdKrav = {
		sub: String(krav.sub),
		navn: (krav.name as string) ?? 'Ukjent',
		pid: (krav[CLAIM.PID] as string) ?? null,
		hprNummer: (krav[CLAIM.HPR_NUMBER] as string) ?? null,
		sikkerhetsniva,
		rå: krav
	};

	const { bruker, roller, nyBruker } = await koblePaLokalBruker(parsed);
	return { ok: true, krav: parsed, retur: tilstand.retur, bruker, roller, nyBruker };
}

/**
 * Finner den lokale brukeren for en HelseID-identitet, eller oppretter den.
 *
 * Kobling skjer på `sub` (stabil i HelseID) og sekundært på HPR-nummer, slik at
 * en bruker som er forhåndsregistrert av systemansvarlig kobles automatisk ved
 * første pålogging. Nye brukere opprettes uten roller og uten tilgang.
 */
export async function koblePaLokalBruker(
	krav: HelseIdKrav
): Promise<{ bruker: Bruker; roller: Rolle[]; nyBruker: boolean }> {
	return transaction(async () => {
		let rad = await en<{ id: string }>('SELECT id FROM user_account WHERE helseid_sub = $1', [krav.sub]);

		if (!rad && krav.hprNummer) {
			rad = await en<{ id: string }>('SELECT id FROM user_account WHERE hpr_nummer = $1 AND helseid_sub IS NULL', [krav.hprNummer]);
			if (rad) {
				await exec('UPDATE user_account SET helseid_sub = $2, navn = $3, oppdatert = now() WHERE id = $1', [rad.id, krav.sub, krav.navn]);
			}
		}

		if (rad) {
			await exec('UPDATE user_account SET siste_innlogging = now(), feilede_forsok = 0, laast_til = NULL WHERE id = $1', [rad.id]);
			const bruker = await hentBruker(rad.id);
			if (!bruker) throw new Error('Fant ikke brukeren etter kobling');
			return { bruker, roller: await rollerFor(bruker.id), nyBruker: false };
		}

		const brukernavn = krav.hprNummer ? `hpr-${krav.hprNummer}` : `helseid-${krav.sub.slice(0, 12)}`;
		const bruker = await opprettBruker({
			brukernavn,
			navn: krav.navn,
			hprNummer: krav.hprNummer ?? undefined,
			roller: [] // roller tildeles av systemansvarlig
		});
		await exec('UPDATE user_account SET helseid_sub = $2, ma_bytte_passord = false, siste_innlogging = now() WHERE id = $1', [bruker.id, krav.sub]);
		const oppdatert = await hentBruker(bruker.id);
		return { bruker: oppdatert ?? bruker, roller: [], nyBruker: true };
	});
}

export function erKonfigurert(): boolean {
	const h = config.integrasjoner.helseId;
	return h.enabled && Boolean(h.clientId) && Boolean(h.privateKeyPem);
}
