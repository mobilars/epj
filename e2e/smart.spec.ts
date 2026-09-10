import { expect, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { logIn, waitOnHydration } from './hjelpere';

/**
 * SMART on FHIR end to end.
 *
 * Walks the whole flow a third-party app actually uses: .well-known discovery,
 * EHR launch from the record, the consent dialog, exchanging the authorisation
 * code with PKCE, and calls to /fhir with the token - including that the app
 * gets no further than its scopes.
 */

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const REDIRECT = 'http://localhost:4000/callback';

/** Fetches the client_id for the demo app from a patient's app tab. */
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

		// Find the patient and the registered demo app.
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Bakken/ }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		const patientId = page.url().split('/pasienter/')[1].split(/[/?]/)[0];

		// The clinician launches the app from the record (EHR launch).
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

		// The app sends the user to the authorisation endpoint.
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

		// The consent dialog explains the access in Norwegian and names the patient.
		await expect(page.getByRole('heading', { name: /Gi tilgang til «Diabetesoversikt/ })).toBeVisible();
		await expect(page.getByText('Anne Bakken')).toBeVisible();
		await expect(page.getByText('målinger og prøvesvar')).toBeVisible();
		await expect(page.getByText('Dr. Ingrid Fastlege')).toBeVisible();

		// The user approves. We do not follow the redirect, but read the code.
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

		// The app reads the patient it has context for.
		const patient = await page.request.get(`/fhir/Patient/${patientId}`, { headers: auth });
		expect(patient.ok(), `status ${patient.status()}: ${await patient.text()}`).toBe(true);
		expect((await patient.json()).resourceType).toBe('Patient');

		// And the observations it has scope for.
		const obs = await page.request.post('/fhir/Observation/_search', {
			headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
			form: { patient: `Patient/${patientId}` }
		});
		expect(obs.ok()).toBe(true);
		expect((await obs.json()).entry.length).toBeGreaterThan(0);

		// But not diagnoses - those are outside the scope the app was given.
		const cond = await page.request.get(`/fhir/Condition?patient=Patient/${patientId}`, { headers: auth });
		expect(cond.status()).toBe(403);

		// And not a patient other than the one in launch context.
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Nordli/ }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		const annenPatient = page.url().split('/pasienter/')[1].split(/[/?]/)[0];
		const forbudt = await page.request.get(`/fhir/Patient/${annenPatient}`, { headers: auth });
		expect(forbudt.status()).toBe(403);

		// The call from the app is logged with the app's identity.
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
		// No redirect: the record must not be usable as an open redirector.
		expect(response.status()).toBe(400);
	});
});
