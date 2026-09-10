import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { logIn, waitOnHydration } from './hjelpere';

/**
 * SMART on FHIR fra ende til ende.
 *
 * Går gjennom hele flyten en tredjepartsapp faktisk bruker: oppslag i
 * .well-known, EHR launch fra journalen, samtykkedialog, innbytte av
 * autorisasjonskode med PKCE, og kall mot /fhir med tokenet - inkludert at
 * appen ikke kommer lenger enn scopene sine.
 */

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const REDIRECT = 'http://localhost:4000/callback';

/** Henter client_id for demoappen fra en pasients app-fane. */
async function getClientId(page: import('@playwright/test').Page): Promise<string> {
	await page.goto('/pasienter');
	await waitOnHydration(page);
	await page.getByRole('link', { name: /Bakken/ }).first().click();
	await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
	const id = page.url().split('/pasienter/')[1].split(/[/?]/)[0];
	await page.goto(`/pasienter/${id}/apper`);
	return ((await page.getByTestId('client-id').first().textContent()) as string).trim();
}

test.describe('SMART on FHIR', () => {
	test('annonserer riktige egenskaper i .well-known', async ({ request }) => {
		const response = await request.get('/.well-known/smart-configuration');
		expect(response.ok()).toBe(true);
		const konfig = await response.json();

		expect(konfig.authorization_endpoint).toContain('/oauth/authorize');
		expect(konfig.token_endpoint).toContain('/oauth/token');
		expect(konfig.code_challenge_methods_supported).toEqual(['S256']);
		expect(konfig.capabilities).toContain('launch-ehr');
		expect(konfig.capabilities).toContain('permission-v2');
		expect(konfig.capabilities).toContain('client-confidential-asymmetric');
		expect(konfig.grant_types_supported).toContain('client_credentials');
	});

	test('publiserer nøkler og OpenID-metadata', async ({ request }) => {
		const jwks = await (await request.get('/oauth/jwks')).json();
		expect(jwks.keys.length).toBeGreaterThan(0);
		expect(jwks.keys[0].kty).toBe('EC');
		expect(jwks.keys[0]).not.toHaveProperty('d'); // aldri privat nøkkelmateriale

		const oidc = await (await request.get('/.well-known/openid-configuration')).json();
		expect(oidc.id_token_signing_alg_values_supported).toContain('ES256');
	});

	test('krever autentisering på FHIR-endepunktet', async ({ request }) => {
		const response = await request.get('/fhir/Patient');
		expect(response.status()).toBe(401);
		expect(response.headers()['www-authenticate']).toContain('Bearer');
		const body = await response.json();
		expect(body.resourceType).toBe('OperationOutcome');
	});

	test('avviser oppdiktet token', async ({ request }) => {
		const response = await request.get('/fhir/Patient', { headers: { authorization: 'Bearer noe.helt.oppdiktet' } });
		expect(response.status()).toBe(401);
		expect(response.headers()['www-authenticate']).toContain('invalid_token');
	});

	test('hele autorisasjonsflyten, og appen får bare det den har scope for', async ({ page }) => {
		await logIn(page, 'lege');

		// Finn pasienten og den registrerte demoappen.
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Bakken/ }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		const patientId = page.url().split('/pasienter/')[1].split(/[/?]/)[0];

		// Klinikeren starter appen fra journalen (EHR launch).
		await page.goto(`/pasienter/${patientId}/apper`);
		await expect(page.getByRole('heading', { name: 'Diabetesoversikt (demo)' })).toBeVisible();
		const clientId = (await page.getByTestId('client-id').first().textContent())?.trim() as string;
		expect(clientId).toMatch(/^epj-/);

		await page.getByRole('button', { name: 'Start app' }).click();
		const launchUrl = new URL(
			(await page.getByRole('link', { name: 'Åpne appen' }).getAttribute('href')) as string
		);
		expect(launchUrl.searchParams.get('iss')).toContain('/fhir');
		const launch = launchUrl.searchParams.get('launch') as string;
		expect(launch.length).toBeGreaterThan(10);

		// Appen sender brukeren til autorisasjonsendepunktet.
		const { verifier, challenge } = pkce();
		const state = randomBytes(8).toString('hex');
		const search = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: REDIRECT,
			scope: 'openid fhirUser launch launch/patient patient/Patient.rs patient/Observation.rs',
			state,
			aud: launchUrl.searchParams.get('iss') as string,
			launch,
			code_challenge: challenge,
			code_challenge_method: 'S256'
		});
		await page.goto(`/oauth/authorize?${search}`);

		// Samtykkedialogen forklarer tilgangen på norsk og navngir pasienten.
		await expect(page.getByRole('heading', { name: /Gi tilgang til «Diabetesoversikt/ })).toBeVisible();
		await expect(page.getByText('Anne Bakken')).toBeVisible();
		await expect(page.getByText('målinger og prøvesvar')).toBeVisible();
		await expect(page.getByText('Dr. Ingrid Fastlege')).toBeVisible();

		// Brukeren godkjenner. Vi følger ikke omdirigeringen, men leser koden.
		const response = await page.request.post('/oauth/authorize?/godkjenn', {
			headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
			form: {
				client_id: clientId,
				redirect_uri: REDIRECT,
				state,
				scope: 'openid fhirUser launch launch/patient patient/Patient.rs patient/Observation.rs',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				patient_id: patientId
			},
			maxRedirects: 0
		});
		expect(response.status()).toBe(303);
		const back = new URL(response.headers()['location']);
		expect(back.searchParams.get('state')).toBe(state);
		const code = back.searchParams.get('code') as string;
		expect(code).toBeTruthy();

		// Appen bytter koden mot tokens.
		const tokenResponse = await page.request.post('/oauth/token', {
			form: {
				grant_type: 'authorization_code',
				code: code,
				redirect_uri: REDIRECT,
				client_id: clientId,
				code_verifier: verifier
			}
		});
		expect(tokenResponse.ok()).toBe(true);
		const tokens = await tokenResponse.json();
		expect(tokens.token_type).toBe('Bearer');
		expect(tokens.patient).toBe(patientId);
		expect(tokens.fhirUser).toContain('Practitioner/');
		expect(tokens.id_token).toBeTruthy();
		expect(tokens.smart_style_url).toContain('/smart-style.json');

		const auth = { authorization: `Bearer ${tokens.access_token}` };

		// Appen leser pasienten den har kontekst for.
		const patient = await page.request.get(`/fhir/Patient/${patientId}`, { headers: auth });
		expect(patient.ok(), `status ${patient.status()}: ${await patient.text()}`).toBe(true);
		expect((await patient.json()).resourceType).toBe('Patient');

		// Og målingene den har scope for.
		const obs = await page.request.post('/fhir/Observation/_search', {
			headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
			form: { patient: `Patient/${patientId}` }
		});
		expect(obs.ok()).toBe(true);
		expect((await obs.json()).entry.length).toBeGreaterThan(0);

		// Men ikke diagnoser - de er utenfor scopet appen fikk.
		const cond = await page.request.get(`/fhir/Condition?patient=Patient/${patientId}`, { headers: auth });
		expect(cond.status()).toBe(403);

		// Og ikke en annen pasient enn den i launch-konteksten.
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Nordli/ }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		const annenPatient = page.url().split('/pasienter/')[1].split(/[/?]/)[0];
		const forbudt = await page.request.get(`/fhir/Patient/${annenPatient}`, { headers: auth });
		expect(forbudt.status()).toBe(403);

		// Kallet fra appen er loggført med appens identitet.
		await page.goto(`/pasienter/${patientId}/logg`);
		await expect(page.getByText(clientId).first()).toBeVisible();
	});

	test('avslag i samtykkedialogen gir access_denied tilbake til appen', async ({ page }) => {
		await logIn(page, 'lege');
		const clientId = await getClientId(page);

		const state = randomBytes(8).toString('hex');
		const response = await page.request.post('/oauth/authorize?/avslaa', {
			headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
			form: { client_id: clientId, redirect_uri: REDIRECT, state },
			maxRedirects: 0
		});
		expect(response.status()).toBe(303);
		const back = new URL(response.headers()['location']);
		expect(back.searchParams.get('error')).toBe('access_denied');
		expect(back.searchParams.get('state')).toBe(state);
	});

	test('autorisasjonsforespørsel uten PKCE avvises', async ({ page }) => {
		await logIn(page, 'lege');
		const clientId = await getClientId(page);

		const search = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: REDIRECT,
			scope: 'patient/Patient.rs',
			state: 'abc'
		});
		const response = await page.request.get(`/oauth/authorize?${search}`, { maxRedirects: 0 });
		expect(response.status()).toBe(303);
		expect(decodeURIComponent(response.headers()['location'])).toContain('PKCE');
	});

	test('ukjent redirect_uri omdirigeres ikke tilbake', async ({ page }) => {
		await logIn(page, 'lege');
		const clientId = await getClientId(page);

		const search = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: 'https://angriper.example/cb',
			scope: 'patient/Patient.rs',
			state: 'abc',
			code_challenge: pkce().challenge,
			code_challenge_method: 'S256'
		});
		const response = await page.request.get(`/oauth/authorize?${search}`, { maxRedirects: 0 });
		// Ingen omdirigering: journalen skal ikke kunne brukes som åpen viderekobling.
		expect(response.status()).toBe(400);
	});
});
