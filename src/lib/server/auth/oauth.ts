import { en, exec, transaction } from '../db';
import { config } from '../config';
import { tokenHash } from '../util/crypto';
import { nyId, nyToken } from '../util/ids';
import type { LaunchKontekst } from '../authz/context';
import { pkceUtfordring, utstedTokens, type UtstedtToken } from './tokens';
import { gyldigRedirectUri, type OAuthKlient } from './klienter';

/**
 * Autorisasjonskodeflyt etter OAuth 2.1 og SMART App Launch 2.x.
 *
 * PKCE (S256) er påkrevd for alle klienter, også konfidensielle. Koden er
 * engangsbruk og kortlivet, og bindes til klient, redirect_uri og bruker.
 */

export interface KodeInn {
	clientId: string;
	userId: string;
	redirectUri: string;
	scope: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	nonce?: string | null;
	launch: LaunchKontekst;
}

export async function opprettAutorisasjonskode(inn: KodeInn): Promise<string> {
	const kode = nyToken(32);
	await exec(
		`INSERT INTO oauth_authorization_code
		 (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, nonce, launch_context, utloper)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)`,
		[
			tokenHash(kode), inn.clientId, inn.userId, inn.redirectUri, inn.scope,
			inn.codeChallenge, inn.codeChallengeMethod, inn.nonce ?? null,
			JSON.stringify(inn.launch), String(config.oauth.authorizationCodeTtl)
		]
	);
	return kode;
}

export type KodeBytte =
	| { ok: true; tokens: UtstedtToken }
	| { ok: false; feil: string; beskrivelse: string };

export async function bytteInnKode(
	kode: string,
	klient: OAuthKlient,
	redirectUri: string,
	codeVerifier: string | null
): Promise<KodeBytte> {
	return transaction(async () => {
		const rad = await en<{
			code_hash: string; client_id: string; user_id: string; redirect_uri: string; scope: string;
			code_challenge: string; code_challenge_method: string; nonce: string | null;
			launch_context: LaunchKontekst; utloper: string; brukt: boolean;
		}>('SELECT * FROM oauth_authorization_code WHERE code_hash = $1 FOR UPDATE', [tokenHash(kode)]);

		if (!rad) return { ok: false as const, feil: 'invalid_grant', beskrivelse: 'Ukjent autorisasjonskode' };
		if (rad.brukt) {
			// Gjenbruk av kode: trekk tilbake alt som er utstedt til klienten for brukeren.
			await exec(
				"UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = 'gjenbruk av autorisasjonskode' WHERE client_id = $1 AND user_id = $2",
				[rad.client_id, rad.user_id]
			);
			return { ok: false as const, feil: 'invalid_grant', beskrivelse: 'Autorisasjonskoden er allerede brukt' };
		}
		if (new Date(rad.utloper).getTime() <= Date.now()) {
			return { ok: false as const, feil: 'invalid_grant', beskrivelse: 'Autorisasjonskoden er utløpt' };
		}
		if (rad.client_id !== klient.client_id) {
			return { ok: false as const, feil: 'invalid_grant', beskrivelse: 'Koden tilhører en annen klient' };
		}
		if (rad.redirect_uri !== redirectUri) {
			return { ok: false as const, feil: 'invalid_grant', beskrivelse: 'redirect_uri stemmer ikke med autorisasjonsforespørselen' };
		}
		if (!codeVerifier) {
			return { ok: false as const, feil: 'invalid_request', beskrivelse: 'code_verifier mangler' };
		}
		const forventet = rad.code_challenge_method === 'S256' ? pkceUtfordring(codeVerifier) : codeVerifier;
		if (forventet !== rad.code_challenge) {
			return { ok: false as const, feil: 'invalid_grant', beskrivelse: 'PKCE-verifisering feilet' };
		}

		await exec('UPDATE oauth_authorization_code SET brukt = true WHERE code_hash = $1', [rad.code_hash]);

		const scopes = rad.scope.split(/\s+/);
		const tokens = await utstedTokens({
			clientId: klient.client_id,
			userId: rad.user_id,
			scope: rad.scope,
			launch: rad.launch_context ?? {},
			medRefresh: scopes.includes('offline_access') || scopes.includes('online_access'),
			nonce: rad.nonce
		});
		return { ok: true as const, tokens };
	});
}

/** EHR launch: journalen oppretter kontekst før SMART-appen åpnes. */
export async function opprettLaunch(inn: {
	clientId: string;
	userId: string;
	patientId?: string | null;
	encounterId?: string | null;
	intent?: string | null;
}): Promise<string> {
	const launchId = nyToken(24);
	await exec(
		`INSERT INTO smart_launch (launch_id, client_id, user_id, patient_id, encounter_id, intent, utloper)
		 VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
		[launchId, inn.clientId, inn.userId, inn.patientId ?? null, inn.encounterId ?? null, inn.intent ?? null, String(config.oauth.launchTtl)]
	);
	return launchId;
}

export async function forbrukLaunch(launchId: string, clientId: string, userId: string): Promise<LaunchKontekst | null> {
	const rad = await en<{ patient_id: string | null; encounter_id: string | null; intent: string | null; brukt: boolean; utloper: string; client_id: string; user_id: string }>(
		'SELECT patient_id, encounter_id, intent, brukt, utloper, client_id, user_id FROM smart_launch WHERE launch_id = $1',
		[launchId]
	);
	if (!rad || rad.brukt) return null;
	if (rad.client_id !== clientId || rad.user_id !== userId) return null;
	if (new Date(rad.utloper).getTime() <= Date.now()) return null;
	await exec('UPDATE smart_launch SET brukt = true WHERE launch_id = $1', [launchId]);
	return { patientId: rad.patient_id, encounterId: rad.encounter_id, intent: rad.intent };
}

export interface AutorisasjonsForesporsel {
	response_type: string;
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
	aud?: string;
	launch?: string;
	code_challenge?: string;
	code_challenge_method?: string;
	nonce?: string;
	prompt?: string;
}

export type Validering =
	| { ok: true; foresporsel: AutorisasjonsForesporsel; klient: OAuthKlient }
	| { ok: false; feil: string; beskrivelse: string; kanOmdirigere: boolean; redirectUri?: string; state?: string };

/**
 * Validerer autorisasjonsforespørselen.
 *
 * Feil i `client_id`/`redirect_uri` skal aldri omdirigeres tilbake - da kunne en
 * angriper bruke journalen som åpen omdirigering.
 */
export function validerAutorisasjonsforesporsel(
	sok: URLSearchParams,
	klient: OAuthKlient | null
): Validering {
	const f: AutorisasjonsForesporsel = {
		response_type: sok.get('response_type') ?? '',
		client_id: sok.get('client_id') ?? '',
		redirect_uri: sok.get('redirect_uri') ?? '',
		scope: sok.get('scope') ?? '',
		state: sok.get('state') ?? '',
		aud: sok.get('aud') ?? undefined,
		launch: sok.get('launch') ?? undefined,
		code_challenge: sok.get('code_challenge') ?? undefined,
		code_challenge_method: sok.get('code_challenge_method') ?? undefined,
		nonce: sok.get('nonce') ?? undefined,
		prompt: sok.get('prompt') ?? undefined
	};

	const avvis = (feil: string, beskrivelse: string, kanOmdirigere = true): Validering => ({
		ok: false, feil, beskrivelse, kanOmdirigere,
		redirectUri: kanOmdirigere ? f.redirect_uri : undefined,
		state: f.state
	});

	if (!klient) return avvis('unauthorized_client', 'Ukjent client_id', false);
	if (klient.status !== 'aktiv') return avvis('unauthorized_client', 'Klienten er sperret', false);
	if (!gyldigRedirectUri(klient, f.redirect_uri)) return avvis('invalid_request', 'redirect_uri er ikke registrert', false);
	if (f.response_type !== 'code') return avvis('unsupported_response_type', 'Kun response_type=code støttes');
	if (!f.state) return avvis('invalid_request', 'state er påkrevd');
	if (!f.code_challenge) return avvis('invalid_request', 'PKCE (code_challenge) er påkrevd');
	if ((f.code_challenge_method ?? 'plain') !== 'S256') return avvis('invalid_request', 'code_challenge_method må være S256');
	if (!klient.grant_types.includes('authorization_code')) return avvis('unauthorized_client', 'Klienten kan ikke bruke authorization_code');
	if (f.aud && !f.aud.startsWith(config.fhirBaseUrl) && f.aud !== config.fhirBaseUrl) {
		return avvis('invalid_request', `aud må være ${config.fhirBaseUrl}`);
	}
	if (f.scope.split(/\s+/).includes('launch') && !f.launch) {
		return avvis('invalid_request', 'scope «launch» krever parameteren launch');
	}

	return { ok: true, foresporsel: f, klient };
}

export function feilOmdirigering(redirectUri: string, feil: string, beskrivelse: string, state?: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set('error', feil);
	url.searchParams.set('error_description', beskrivelse);
	if (state) url.searchParams.set('state', state);
	return url.toString();
}

export async function ryddUtlopteKoder(): Promise<number> {
	const a = await exec("DELETE FROM oauth_authorization_code WHERE utloper < now() - interval '1 day'");
	const b = await exec("DELETE FROM smart_launch WHERE utloper < now() - interval '1 day'");
	return a + b;
}

export function nyStateVerdi(): string {
	return nyId();
}
