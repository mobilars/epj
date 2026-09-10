import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { en, exec, query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase, settInn } from './fixtures/db';
import { autentiserKlient, gyldigRedirectUri, registrerKlient, settKlientstatus, type OAuthKlient } from '../src/lib/server/auth/klienter';
import {
	bytteInnKode,
	forbrukLaunch,
	opprettAutorisasjonskode,
	opprettLaunch,
	validerAutorisasjonsforesporsel
} from '../src/lib/server/auth/oauth';
import { fornyMedRefreshToken, introspiser, pkceUtfordring, tilbakekallForBruker, utstedTokens, validerAccessToken } from '../src/lib/server/auth/tokens';
import { jwks, roterNokkel, tomNokkelCache } from '../src/lib/server/auth/keys';
import { signer, type Jwk } from '../src/lib/server/auth/jws';
import { config } from '../src/lib/server/config';
import { nyId } from '../src/lib/server/util/ids';

const beskriv = harTestdatabase() ? describe : describe.skip;

const REDIRECT = 'http://localhost:4000/callback';

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

beskriv('OAuth 2.1 og SMART App Launch', () => {
	let db: Testdatabase;
	let clientId = '';
	let hemmelighet: string | undefined;

	beforeAll(async () => { db = await opprettTestdatabase('oauth'); });
	afterAll(async () => { await db.riv(); });

	beforeEach(async () => {
		await tomTabeller();
		tomNokkelCache();
		await settInn('INSERT INTO user_account (id, brukernavn, navn, practitioner_id) VALUES ($1,$2,$3,$4)', ['bruker-1', 'lege', 'Dr. Ingrid Fastlege', 'prac-42']);
		await exec('INSERT INTO role_assignment (id, user_id, rolle) VALUES ($1,$2,$3)', [nyId(), 'bruker-1', 'lege']);
		const reg = await registrerKlient({
			navn: 'Testapp',
			type: 'public',
			kategori: 'smart-ehr',
			redirectUris: [REDIRECT],
			scopes: ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access', 'patient/Patient.rs', 'patient/Observation.rs']
		});
		clientId = reg.klient.client_id;
		hemmelighet = reg.secret;
	});

	describe('validering av autorisasjonsforespørsel', () => {
		const sok = (over: Record<string, string> = {}) =>
			new URLSearchParams({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT,
				scope: 'openid patient/Patient.rs',
				state: 'st-1',
				code_challenge: pkce().challenge,
				code_challenge_method: 'S256',
				aud: config.fhirBaseUrl,
				...over
			});

		it('godtar en korrekt forespørsel', async () => {
			const v = validerAutorisasjonsforesporsel(sok(), await hentKlientRad());
			expect(v.ok).toBe(true);
		});

		it('avviser ukjent klient uten å omdirigere', () => {
			const v = validerAutorisasjonsforesporsel(sok(), null);
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.kanOmdirigere).toBe(false);
		});

		it('avviser redirect_uri som ikke er registrert, uten å omdirigere', async () => {
			const v = validerAutorisasjonsforesporsel(sok({ redirect_uri: 'https://angriper.example/cb' }), await hentKlientRad());
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.kanOmdirigere).toBe(false);
		});

		it('krever PKCE med S256', async () => {
			const utenPkce = sok();
			utenPkce.delete('code_challenge');
			const v1 = validerAutorisasjonsforesporsel(utenPkce, await hentKlientRad());
			expect(v1.ok).toBe(false);

			const v2 = validerAutorisasjonsforesporsel(sok({ code_challenge_method: 'plain' }), await hentKlientRad());
			expect(v2.ok).toBe(false);
		});

		it('krever state', async () => {
			const v = validerAutorisasjonsforesporsel(sok({ state: '' }), await hentKlientRad());
			expect(v.ok).toBe(false);
		});

		it('avviser andre response_type enn code', async () => {
			const v = validerAutorisasjonsforesporsel(sok({ response_type: 'token' }), await hentKlientRad());
			expect(v.ok).toBe(false);
		});

		it('krever launch-parameter når scope inneholder «launch»', async () => {
			const v = validerAutorisasjonsforesporsel(sok({ scope: 'launch patient/Patient.rs' }), await hentKlientRad());
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.beskrivelse).toMatch(/launch/);
		});

		it('avviser feil aud', async () => {
			const v = validerAutorisasjonsforesporsel(sok({ aud: 'https://feil.example/fhir' }), await hentKlientRad());
			expect(v.ok).toBe(false);
		});

		it('avviser sperret klient', async () => {
			await settKlientstatus(clientId, 'sperret');
			const v = validerAutorisasjonsforesporsel(sok(), await hentKlientRad());
			expect(v.ok).toBe(false);
		});

		it('sammenlikner redirect_uri eksakt', async () => {
			const k = await hentKlientRad();
			expect(gyldigRedirectUri(k, REDIRECT)).toBe(true);
			expect(gyldigRedirectUri(k, `${REDIRECT}/`)).toBe(false);
			expect(gyldigRedirectUri(k, `${REDIRECT}?x=1`)).toBe(false);
		});
	});

	describe('autorisasjonskode', () => {
		it('bytter kode mot tokens med riktig verifier', async () => {
			const { verifier, challenge } = pkce();
			const kode = await opprettAutorisasjonskode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT,
				scope: 'openid fhirUser patient/Patient.rs offline_access',
				codeChallenge: challenge, codeChallengeMethod: 'S256',
				launch: { patientId: 'pas-1' }
			});
			const resultat = await bytteInnKode(kode, await hentKlientRad(), REDIRECT, verifier);
			expect(resultat.ok).toBe(true);
			if (!resultat.ok) return;
			expect(resultat.tokens.access_token.split('.')).toHaveLength(3);
			expect(resultat.tokens.patient).toBe('pas-1');
			expect(resultat.tokens.refresh_token).toBeDefined();
			expect(resultat.tokens.id_token).toBeDefined();
			expect(resultat.tokens.fhirUser).toContain('Practitioner/prac-42');
			expect(resultat.tokens.smart_style_url).toContain('/smart-style.json');
		});

		it('avviser feil code_verifier', async () => {
			const { challenge } = pkce();
			const kode = await opprettAutorisasjonskode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const resultat = await bytteInnKode(kode, await hentKlientRad(), REDIRECT, 'feil-verifier');
			expect(resultat.ok).toBe(false);
			if (!resultat.ok) expect(resultat.beskrivelse).toMatch(/PKCE/);
		});

		it('avviser manglende code_verifier', async () => {
			const { challenge } = pkce();
			const kode = await opprettAutorisasjonskode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const resultat = await bytteInnKode(kode, await hentKlientRad(), REDIRECT, null);
			expect(resultat.ok).toBe(false);
		});

		it('avviser feil redirect_uri ved innbytte', async () => {
			const { verifier, challenge } = pkce();
			const kode = await opprettAutorisasjonskode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const resultat = await bytteInnKode(kode, await hentKlientRad(), 'http://localhost:4000/annen', verifier);
			expect(resultat.ok).toBe(false);
		});

		it('trekker tilbake alt ved gjenbruk av kode', async () => {
			const { verifier, challenge } = pkce();
			const kode = await opprettAutorisasjonskode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs offline_access',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const forste = await bytteInnKode(kode, await hentKlientRad(), REDIRECT, verifier);
			expect(forste.ok).toBe(true);

			const andre = await bytteInnKode(kode, await hentKlientRad(), REDIRECT, verifier);
			expect(andre.ok).toBe(false);

			const tokens = await query<{ tilbakekalt: boolean }>('SELECT tilbakekalt FROM oauth_token WHERE user_id = $1', ['bruker-1']);
			expect(tokens.every((t) => t.tilbakekalt)).toBe(true);
		});

		it('avviser utløpt kode', async () => {
			const { verifier, challenge } = pkce();
			const kode = await opprettAutorisasjonskode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			await exec("UPDATE oauth_authorization_code SET utloper = now() - interval '1 minute'");
			const resultat = await bytteInnKode(kode, await hentKlientRad(), REDIRECT, verifier);
			expect(resultat.ok).toBe(false);
			if (!resultat.ok) expect(resultat.beskrivelse).toMatch(/utløpt/);
		});
	});

	describe('EHR launch', () => {
		it('gir pasientkontekst én gang', async () => {
			const launchId = await opprettLaunch({ clientId, userId: 'bruker-1', patientId: 'pas-1', encounterId: 'enc-1' });
			const forste = await forbrukLaunch(launchId, clientId, 'bruker-1');
			expect(forste).toMatchObject({ patientId: 'pas-1', encounterId: 'enc-1' });
			expect(await forbrukLaunch(launchId, clientId, 'bruker-1')).toBeNull();
		});

		it('nekter en annen klient eller bruker å bruke konteksten', async () => {
			const launchId = await opprettLaunch({ clientId, userId: 'bruker-1', patientId: 'pas-1' });
			expect(await forbrukLaunch(launchId, 'annen-klient', 'bruker-1')).toBeNull();
			expect(await forbrukLaunch(launchId, clientId, 'annen-bruker')).toBeNull();
		});

		it('utløper', async () => {
			const launchId = await opprettLaunch({ clientId, userId: 'bruker-1', patientId: 'pas-1' });
			await exec("UPDATE smart_launch SET utloper = now() - interval '1 minute'");
			expect(await forbrukLaunch(launchId, clientId, 'bruker-1')).toBeNull();
		});
	});

	describe('access token', () => {
		it('validerer og bygger tilgangskontekst', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: { patientId: 'pas-1' }, medRefresh: false });
			const v = await validerAccessToken(tokens.access_token);
			expect(v.gyldig).toBe(true);
			expect(v.ctx?.roller).toContain('lege');
			expect(v.ctx?.launch.patientId).toBe('pas-1');
			expect(v.ctx?.actorRef).toBe('Practitioner/prac-42');
		});

		it('avviser tilbakekalt token', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: {}, medRefresh: false });
			await tilbakekallForBruker('bruker-1', 'arbeidsforhold avsluttet');
			const v = await validerAccessToken(tokens.access_token);
			expect(v.gyldig).toBe(false);
			expect(v.feil).toMatch(/tilbake/);
		});

		it('avviser token som ikke finnes i databasen', async () => {
			const { privatePkcs8, publicJwk } = await lagFremmedNokkel();
			const falskt = signer({ iss: config.issuer, sub: 'bruker-1', jti: nyId(), exp: Math.floor(Date.now() / 1000) + 600 }, privatePkcs8, publicJwk.kid as string);
			expect((await validerAccessToken(falskt)).gyldig).toBe(false);
		});

		it('introspeksjon gir active=false for ugyldig token', async () => {
			expect(await introspiser('tull')).toMatchObject({ active: false });
		});

		it('introspeksjon gir metadata for gyldig token', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: { patientId: 'pas-7' }, medRefresh: false });
			const svar = await introspiser(tokens.access_token);
			expect(svar).toMatchObject({ active: true, client_id: clientId, patient: 'pas-7' });
		});

		it('overlever nøkkelrotasjon', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: {}, medRefresh: false });
			await roterNokkel();
			expect((await jwks()).keys.length).toBeGreaterThanOrEqual(2);
			expect((await validerAccessToken(tokens.access_token)).gyldig).toBe(true);
		});
	});

	describe('refresh token', () => {
		it('roterer ved bruk', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, medRefresh: true });
			const fornyet = await fornyMedRefreshToken(tokens.refresh_token as string, clientId);
			expect(fornyet.ok).toBe(true);
			expect(fornyet.tokens?.refresh_token).not.toBe(tokens.refresh_token);
		});

		it('oppdager gjenbruk og trekker tilbake hele familien', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, medRefresh: true });
			await fornyMedRefreshToken(tokens.refresh_token as string, clientId);
			const gjenbruk = await fornyMedRefreshToken(tokens.refresh_token as string, clientId);
			expect(gjenbruk.ok).toBe(false);
			expect(gjenbruk.feil).toMatch(/trukket tilbake/);
		});

		it('nekter en annen klient å bruke tokenet', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, medRefresh: true });
			const svar = await fornyMedRefreshToken(tokens.refresh_token as string, 'annen-klient');
			expect(svar.ok).toBe(false);
		});

		it('lar scope snevres inn, men ikke utvides', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs patient/Observation.rs offline_access', launch: {}, medRefresh: true });
			const smalere = await fornyMedRefreshToken(tokens.refresh_token as string, clientId, 'patient/Patient.rs');
			expect(smalere.tokens?.scope).toBe('patient/Patient.rs');

			const bredere = await fornyMedRefreshToken(smalere.tokens?.refresh_token as string, clientId, 'patient/Patient.rs user/*.cruds');
			expect(bredere.tokens?.scope).toBe('patient/Patient.rs');
		});

		it('avviser utløpt refresh token', async () => {
			const tokens = await utstedTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, medRefresh: true });
			await exec("UPDATE oauth_token SET utloper = now() - interval '1 day' WHERE kind = 'refresh'");
			expect((await fornyMedRefreshToken(tokens.refresh_token as string, clientId)).ok).toBe(false);
		});
	});

	describe('klientautentisering', () => {
		it('godtar offentlig klient uten hemmelighet', async () => {
			const auth = await autentiserKlient(new URLSearchParams({ client_id: clientId }), null);
			expect(auth.ok).toBe(true);
			if (auth.ok) expect(auth.metode).toBe('none');
		});

		it('krever riktig hemmelighet for konfidensiell klient', async () => {
			const reg = await registrerKlient({ navn: 'Konfidensiell', type: 'confidential', kategori: 'smart-standalone', redirectUris: [REDIRECT], scopes: [] });
			const ok = await autentiserKlient(new URLSearchParams({ client_id: reg.klient.client_id, client_secret: reg.secret as string }), null);
			expect(ok.ok).toBe(true);

			const feil = await autentiserKlient(new URLSearchParams({ client_id: reg.klient.client_id, client_secret: 'gal' }), null);
			expect(feil.ok).toBe(false);
		});

		it('godtar client_secret_basic', async () => {
			const reg = await registrerKlient({ navn: 'Basic', type: 'confidential', kategori: 'backend', redirectUris: [], scopes: [] });
			const header = `Basic ${Buffer.from(`${reg.klient.client_id}:${reg.secret}`).toString('base64')}`;
			const auth = await autentiserKlient(new URLSearchParams(), header);
			expect(auth.ok).toBe(true);
			if (auth.ok) expect(auth.metode).toBe('client_secret_basic');
		});

		it('godtar private_key_jwt og avviser gjenbrukt jti', async () => {
			const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
			const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'ES256' };
			const reg = await registrerKlient({
				navn: 'Backend', type: 'confidential', kategori: 'backend',
				redirectUris: [], scopes: ['system/Patient.rs'], jwks: { keys: [jwk] }
			});

			const jti = nyId();
			const lagAssertion = (medJti: string) =>
				signer(
					{
						iss: reg.klient.client_id, sub: reg.klient.client_id,
						aud: `${config.baseUrl}/oauth/token`, jti: medJti,
						exp: Math.floor(Date.now() / 1000) + 60
					},
					privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
					'k1'
				);

			const form = (assertion: string) =>
				new URLSearchParams({
					client_id: reg.klient.client_id,
					client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
					client_assertion: assertion
				});

			const forste = await autentiserKlient(form(lagAssertion(jti)), null);
			expect(forste.ok).toBe(true);
			if (forste.ok) expect(forste.metode).toBe('private_key_jwt');

			const gjenbruk = await autentiserKlient(form(lagAssertion(jti)), null);
			expect(gjenbruk.ok).toBe(false);
			if (!gjenbruk.ok) expect(gjenbruk.feil).toMatch(/jti/);
		});

		it('avviser client_assertion med feil aud', async () => {
			const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
			const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k2', alg: 'ES256' };
			const reg = await registrerKlient({ navn: 'Backend2', type: 'confidential', kategori: 'backend', redirectUris: [], scopes: [], jwks: { keys: [jwk] } });
			const assertion = signer(
				{ iss: reg.klient.client_id, sub: reg.klient.client_id, aud: 'https://feil.example', jti: nyId(), exp: Math.floor(Date.now() / 1000) + 60 },
				privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
				'k2'
			);
			const auth = await autentiserKlient(
				new URLSearchParams({
					client_id: reg.klient.client_id,
					client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
					client_assertion: assertion
				}),
				null
			);
			expect(auth.ok).toBe(false);
		});

		it('avviser sperret klient', async () => {
			await settKlientstatus(clientId, 'sperret');
			expect((await autentiserKlient(new URLSearchParams({ client_id: clientId }), null)).ok).toBe(false);
		});
	});

	describe('PKCE-hjelper', () => {
		it('regner ut S256-utfordringen', () => {
			// Testvektor fra RFC 7636 appendiks B.
			expect(pkceUtfordring('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
		});
	});
});

async function hentKlientRad(): Promise<OAuthKlient> {
	const { hentKlient } = await import('../src/lib/server/auth/klienter');
	const rad = await en<{ client_id: string }>('SELECT client_id FROM oauth_client ORDER BY opprettet LIMIT 1');
	const klient = await hentKlient(rad?.client_id as string);
	if (!klient) throw new Error('Fant ingen klient i testdatabasen');
	return klient;
}

async function lagFremmedNokkel() {
	const { genererNokkelpar } = await import('../src/lib/server/auth/jws');
	return genererNokkelpar();
}
