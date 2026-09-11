import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { one, exec, query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase, setIn } from './fixtures/db';
import { authenticateClient, validRedirectUri, registerClient, setKlientstatus, type OAuthClient } from '../src/lib/server/auth/clients';
import {
	exchangeInCode,
	consumeLaunch,
	createAuthorisationCode,
	createLaunch,
	validateAuthorisationRequest
} from '../src/lib/server/auth/oauth';
import { renewWithRefreshToken, introspiser, pkceChallenge, revokeForUser, issueTokens, validateAccessToken } from '../src/lib/server/auth/tokens';
import { jwks, rotateKey, emptyKeyCache } from '../src/lib/server/auth/keys';
import { sign, type Jwk } from '../src/lib/server/auth/jws';
import { config } from '../src/lib/server/config';
import { newId } from '../src/lib/server/util/ids';

const describeIf = hasTestDatabase() ? describe : describe.skip;

const REDIRECT = 'http://localhost:4000/callback';

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describeIf('OAuth 2.1 og SMART App Launch', () => {
	let db: TestDatabase;
	let clientId = '';
	let secret: string | undefined;

	beforeAll(async () => { db = await createTestDatabase('oauth'); });
	afterAll(async () => { await db.riv(); });

	beforeEach(async () => {
		await emptyTables();
		emptyKeyCache();
		await setIn('INSERT INTO user_account (id, username, name, practitioner_id) VALUES ($1,$2,$3,$4)', ['bruker-1', 'behandler', 'Dr. Ingrid Fastlege', 'prac-42']);
		await exec('INSERT INTO role_assignment (id, user_id, role) VALUES ($1,$2,$3)', [newId(), 'bruker-1', 'behandler']);
		const reg = await registerClient({
			name: 'Testapp',
			type: 'public',
			category: 'smart-ehr',
			redirectUris: [REDIRECT],
			scopes: ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access', 'patient/Patient.rs', 'patient/Observation.rs']
		});
		clientId = reg.client.client_id;
		secret = reg.secret;
	});

	describe('validering av autorisasjonsforespørsel', () => {
		const search = (over: Record<string, string> = {}) =>
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
			const v = validateAuthorisationRequest(search(), await getClientRow());
			expect(v.ok).toBe(true);
		});

		it('avviser ukjent klient uten å omdirigere', () => {
			const v = validateAuthorisationRequest(search(), null);
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.canRedirect).toBe(false);
		});

		it('avviser redirect_uri som ikke er registrert, uten å omdirigere', async () => {
			const v = validateAuthorisationRequest(search({ redirect_uri: 'https://angriper.example/cb' }), await getClientRow());
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.canRedirect).toBe(false);
		});

		it('krever PKCE med S256', async () => {
			const withoutPkce = search();
			withoutPkce.delete('code_challenge');
			const v1 = validateAuthorisationRequest(withoutPkce, await getClientRow());
			expect(v1.ok).toBe(false);

			const v2 = validateAuthorisationRequest(search({ code_challenge_method: 'plain' }), await getClientRow());
			expect(v2.ok).toBe(false);
		});

		it('krever state', async () => {
			const v = validateAuthorisationRequest(search({ state: '' }), await getClientRow());
			expect(v.ok).toBe(false);
		});

		it('avviser andre response_type enn code', async () => {
			const v = validateAuthorisationRequest(search({ response_type: 'token' }), await getClientRow());
			expect(v.ok).toBe(false);
		});

		it('krever launch-parameter når scope inneholder «launch»', async () => {
			const v = validateAuthorisationRequest(search({ scope: 'launch patient/Patient.rs' }), await getClientRow());
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.description).toMatch(/launch/);
		});

		it('avviser feil aud, og sier hva som kom', async () => {
			const v = validateAuthorisationRequest(search({ aud: 'https://feil.example/fhir' }), await getClientRow());
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.description).toContain('https://feil.example/fhir');
		});

		// An app that reads `issuer` out of the smart-configuration and sends that
		// as `aud` has named this same deployment by its other name. Accepted, but
		// the security log has to show it: the vendor's integration needs the fix.
		it('godtar utstederen som aud, men noterer avviket', async () => {
			const v = validateAuthorisationRequest(search({ aud: config.baseUrl }), await getClientRow());
			expect(v.ok).toBe(true);
			if (v.ok) expect(v.deviations?.join(' ')).toMatch(/utstederen/);
		});

		it('godtar FHIR-endepunktet som aud uten avvik', async () => {
			const v = validateAuthorisationRequest(search({ aud: config.fhirBaseUrl }), await getClientRow());
			expect(v.ok).toBe(true);
			if (v.ok) expect(v.deviations).toBeUndefined();
		});

		it('avviser sperret klient', async () => {
			await setKlientstatus(clientId, 'sperret');
			const v = validateAuthorisationRequest(search(), await getClientRow());
			expect(v.ok).toBe(false);
		});

		it('sammenlikner redirect_uri eksakt', async () => {
			const k = await getClientRow();
			expect(validRedirectUri(k, REDIRECT)).toBe(true);
			expect(validRedirectUri(k, `${REDIRECT}/`)).toBe(false);
			expect(validRedirectUri(k, `${REDIRECT}?x=1`)).toBe(false);
		});
	});

	describe('autorisasjonskode', () => {
		it('bytter kode mot tokens med riktig verifier', async () => {
			const { verifier, challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT,
				scope: 'openid fhirUser patient/Patient.rs offline_access',
				codeChallenge: challenge, codeChallengeMethod: 'S256',
				launch: { patientId: 'pas-1' }
			});
			const result = await exchangeInCode(code, await getClientRow(), REDIRECT, verifier);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.tokens.access_token.split('.')).toHaveLength(3);
			expect(result.tokens.patient).toBe('pas-1');
			expect(result.tokens.refresh_token).toBeDefined();
			expect(result.tokens.id_token).toBeDefined();
			expect(result.tokens.fhirUser).toContain('Practitioner/prac-42');
			expect(result.tokens.smart_style_url).toContain('/smart-style.json');
		});

		// An app that never asked for `fhirUser` must not be told which clinician is
		// at the record. Every app but one requests the scope, so the leak was
		// invisible until an app turned up that did not.
		it('holder fhirUser tilbake når appen ikke har bedt om scopet', async () => {
			const { verifier, challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT,
				scope: 'openid patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256',
				launch: { patientId: 'pas-1' }
			});
			const result = await exchangeInCode(code, await getClientRow(), REDIRECT, verifier);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.tokens.fhirUser).toBeUndefined();
			const claims = JSON.parse(Buffer.from(result.tokens.access_token.split('.')[1], 'base64url').toString());
			expect(claims.fhirUser).toBeUndefined();
			// The patient context is unaffected: it rides on the launch, not the scope.
			expect(result.tokens.patient).toBe('pas-1');
		});

		it('avviser feil code_verifier', async () => {
			const { challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const result = await exchangeInCode(code, await getClientRow(), REDIRECT, 'feil-verifier');
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.description).toMatch(/PKCE/);
		});

		it('avviser manglende code_verifier', async () => {
			const { challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const result = await exchangeInCode(code, await getClientRow(), REDIRECT, null);
			expect(result.ok).toBe(false);
		});

		it('avviser feil redirect_uri ved innbytte', async () => {
			const { verifier, challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const result = await exchangeInCode(code, await getClientRow(), 'http://localhost:4000/annen', verifier);
			expect(result.ok).toBe(false);
		});

		it('trekker tilbake alt ved gjenbruk av kode', async () => {
			const { verifier, challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs offline_access',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			const first = await exchangeInCode(code, await getClientRow(), REDIRECT, verifier);
			expect(first.ok).toBe(true);

			const andre = await exchangeInCode(code, await getClientRow(), REDIRECT, verifier);
			expect(andre.ok).toBe(false);

			const tokens = await query<{ revoked: boolean }>('SELECT revoked FROM oauth_token WHERE user_id = $1', ['bruker-1']);
			expect(tokens.every((t) => t.revoked)).toBe(true);
		});

		it('avviser utløpt kode', async () => {
			const { verifier, challenge } = pkce();
			const code = await createAuthorisationCode({
				clientId, userId: 'bruker-1', redirectUri: REDIRECT, scope: 'patient/Patient.rs',
				codeChallenge: challenge, codeChallengeMethod: 'S256', launch: {}
			});
			await exec("UPDATE oauth_authorization_code SET expires_at = now() - interval '1 minute'");
			const result = await exchangeInCode(code, await getClientRow(), REDIRECT, verifier);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.description).toMatch(/utløpt/);
		});
	});

	describe('EHR launch', () => {
		it('gir pasientkontekst én gang', async () => {
			const launchId = await createLaunch({ clientId, userId: 'bruker-1', patientId: 'pas-1', encounterId: 'enc-1' });
			const first = await consumeLaunch(launchId, clientId, 'bruker-1');
			expect(first).toMatchObject({ patientId: 'pas-1', encounterId: 'enc-1' });
			expect(await consumeLaunch(launchId, clientId, 'bruker-1')).toBeNull();
		});

		it('nekter en annen klient eller bruker å bruke konteksten', async () => {
			const launchId = await createLaunch({ clientId, userId: 'bruker-1', patientId: 'pas-1' });
			expect(await consumeLaunch(launchId, 'annen-klient', 'bruker-1')).toBeNull();
			expect(await consumeLaunch(launchId, clientId, 'annen-bruker')).toBeNull();
		});

		it('utløper', async () => {
			const launchId = await createLaunch({ clientId, userId: 'bruker-1', patientId: 'pas-1' });
			await exec("UPDATE smart_launch SET expires_at = now() - interval '1 minute'");
			expect(await consumeLaunch(launchId, clientId, 'bruker-1')).toBeNull();
		});
	});

	describe('access token', () => {
		it('validerer og bygger tilgangskontekst', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: { patientId: 'pas-1' }, withRefresh: false });
			const v = await validateAccessToken(tokens.access_token);
			expect(v.valid).toBe(true);
			expect(v.ctx?.roles).toContain('behandler');
			expect(v.ctx?.launch.patientId).toBe('pas-1');
			expect(v.ctx?.actorRef).toBe('Practitioner/prac-42');
		});

		it('avviser tilbakekalt token', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: {}, withRefresh: false });
			await revokeForUser('bruker-1', 'arbeidsforhold avsluttet');
			const v = await validateAccessToken(tokens.access_token);
			expect(v.valid).toBe(false);
			expect(v.error).toMatch(/tilbake/);
		});

		it('avviser token som ikke finnes i databasen', async () => {
			const { privatePkcs8, publicJwk } = await layerFremmedKey();
			const falskt = await sign({ iss: config.issuer, sub: 'bruker-1', jti: newId(), exp: Math.floor(Date.now() / 1000) + 600 }, privatePkcs8, publicJwk.kid as string);
			expect((await validateAccessToken(falskt)).valid).toBe(false);
		});

		it('introspeksjon gir active=false for ugyldig token', async () => {
			expect(await introspiser('tull')).toMatchObject({ active: false });
		});

		it('introspeksjon gir metadata for gyldig token', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: { patientId: 'pas-7' }, withRefresh: false });
			const response = await introspiser(tokens.access_token);
			expect(response).toMatchObject({ active: true, client_id: clientId, patient: 'pas-7' });
		});

		it('overlever nøkkelrotasjon', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs', launch: {}, withRefresh: false });
			await rotateKey();
			expect((await jwks()).keys.length).toBeGreaterThanOrEqual(2);
			expect((await validateAccessToken(tokens.access_token)).valid).toBe(true);
		});
	});

	describe('refresh token', () => {
		it('roterer ved bruk', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, withRefresh: true });
			const fornyet = await renewWithRefreshToken(tokens.refresh_token as string, clientId);
			expect(fornyet.ok).toBe(true);
			expect(fornyet.tokens?.refresh_token).not.toBe(tokens.refresh_token);
		});

		it('oppdager gjenbruk og trekker tilbake hele familien', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, withRefresh: true });
			await renewWithRefreshToken(tokens.refresh_token as string, clientId);
			const reuse = await renewWithRefreshToken(tokens.refresh_token as string, clientId);
			expect(reuse.ok).toBe(false);
			expect(reuse.error).toMatch(/trukket tilbake/);
		});

		it('nekter en annen klient å bruke tokenet', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, withRefresh: true });
			const response = await renewWithRefreshToken(tokens.refresh_token as string, 'annen-klient');
			expect(response.ok).toBe(false);
		});

		it('lar scope snevres inn, men ikke utvides', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs patient/Observation.rs offline_access', launch: {}, withRefresh: true });
			const smalere = await renewWithRefreshToken(tokens.refresh_token as string, clientId, 'patient/Patient.rs');
			expect(smalere.tokens?.scope).toBe('patient/Patient.rs');

			const bredere = await renewWithRefreshToken(smalere.tokens?.refresh_token as string, clientId, 'patient/Patient.rs user/*.cruds');
			expect(bredere.tokens?.scope).toBe('patient/Patient.rs');
		});

		it('avviser utløpt refresh token', async () => {
			const tokens = await issueTokens({ clientId, userId: 'bruker-1', scope: 'patient/Patient.rs offline_access', launch: {}, withRefresh: true });
			await exec("UPDATE oauth_token SET expires_at = now() - interval '1 day' WHERE kind = 'refresh'");
			expect((await renewWithRefreshToken(tokens.refresh_token as string, clientId)).ok).toBe(false);
		});
	});

	describe('klientautentisering', () => {
		it('godtar offentlig klient uten hemmelighet', async () => {
			const auth = await authenticateClient(new URLSearchParams({ client_id: clientId }), null);
			expect(auth.ok).toBe(true);
			if (auth.ok) expect(auth.method).toBe('none');
		});

		it('krever riktig hemmelighet for konfidensiell klient', async () => {
			const reg = await registerClient({ name: 'Konfidensiell', type: 'confidential', category: 'smart-standalone', redirectUris: [REDIRECT], scopes: [] });
			const ok = await authenticateClient(new URLSearchParams({ client_id: reg.client.client_id, client_secret: reg.secret as string }), null);
			expect(ok.ok).toBe(true);

			const error = await authenticateClient(new URLSearchParams({ client_id: reg.client.client_id, client_secret: 'gal' }), null);
			expect(error.ok).toBe(false);
		});

		it('godtar client_secret_basic', async () => {
			const reg = await registerClient({ name: 'Basic', type: 'confidential', category: 'backend', redirectUris: [], scopes: [] });
			const header = `Basic ${Buffer.from(`${reg.client.client_id}:${reg.secret}`).toString('base64')}`;
			const auth = await authenticateClient(new URLSearchParams(), header);
			expect(auth.ok).toBe(true);
			if (auth.ok) expect(auth.method).toBe('client_secret_basic');
		});

		it('godtar private_key_jwt og avviser gjenbrukt jti', async () => {
			const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
			const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'ES256' };
			const reg = await registerClient({
				name: 'Backend', type: 'confidential', category: 'backend',
				redirectUris: [], scopes: ['system/Patient.rs'], jwks: { keys: [jwk] }
			});

			const jti = newId();
			const layerAssertion = (withJti: string) =>
				sign(
					{
						iss: reg.client.client_id, sub: reg.client.client_id,
						aud: `${config.baseUrl}/oauth/token`, jti: withJti,
						exp: Math.floor(Date.now() / 1000) + 60
					},
					privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
					'k1'
				);

			const form = (assertion: string) =>
				new URLSearchParams({
					client_id: reg.client.client_id,
					client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
					client_assertion: assertion
				});

			const first = await authenticateClient(form(await layerAssertion(jti)), null);
			expect(first.ok).toBe(true);
			if (first.ok) expect(first.method).toBe('private_key_jwt');

			const reuse = await authenticateClient(form(await layerAssertion(jti)), null);
			expect(reuse.ok).toBe(false);
			if (!reuse.ok) expect(reuse.error).toMatch(/jti/);
		});

		it('avviser client_assertion med feil aud', async () => {
			const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
			const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k2', alg: 'ES256' };
			const reg = await registerClient({ name: 'Backend2', type: 'confidential', category: 'backend', redirectUris: [], scopes: [], jwks: { keys: [jwk] } });
			const assertion = await sign(
				{ iss: reg.client.client_id, sub: reg.client.client_id, aud: 'https://feil.example', jti: newId(), exp: Math.floor(Date.now() / 1000) + 60 },
				privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
				'k2'
			);
			const auth = await authenticateClient(
				new URLSearchParams({
					client_id: reg.client.client_id,
					client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
					client_assertion: assertion
				}),
				null
			);
			expect(auth.ok).toBe(false);
		});

		it('avviser sperret klient', async () => {
			await setKlientstatus(clientId, 'sperret');
			expect((await authenticateClient(new URLSearchParams({ client_id: clientId }), null)).ok).toBe(false);
		});
	});

	describe('PKCE-hjelper', () => {
		it('regner ut S256-utfordringen', () => {
			// Test vector from RFC 7636 appendix B.
			expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
		});
	});
});

async function getClientRow(): Promise<OAuthClient> {
	const { getClient } = await import('../src/lib/server/auth/clients');
	const row = await one<{ client_id: string }>('SELECT client_id FROM oauth_client ORDER BY created_at LIMIT 1');
	const client = await getClient(row?.client_id as string);
	if (!client) throw new Error('Fant ingen klient i testdatabasen');
	return client;
}

async function layerFremmedKey() {
	const { generateKeyPair } = await import('../src/lib/server/auth/jws');
	return generateKeyPair();
}
