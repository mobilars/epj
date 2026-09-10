import { expect, test } from '@playwright/test';
import { logIn, logInPlatform, PLATFORM_URL, waitOnHydration } from './hjelpere';

/**
 * Platform administration.
 *
 * These tests exercise the part the unit tests cannot reach: that the UI really
 * does create an organisation with a partition, that it refuses what should be
 * refused, and - most importantly - that nobody but the platform owner gets in.
 *
 * The platform has its own hostname. In the test environment `localhost` and
 * `127.0.0.1` point at the same server, so both organisations can be reached
 * without the tests needing DNS.
 */
test.describe('plattformadministrasjon', () => {
	test('systemeier ser virksomhetene og partisjonstilstanden', async ({ page }) => {
		await logInPlatform(page);

		// The platform owner has no clinical surface, and goes straight to the platform.
		await expect(page).toHaveURL(/\/systemadmin$/);
		await expect(page.getByRole('heading', { name: 'Plattformadministrasjon' })).toBeVisible();

		// The default organisation took its name and address from the configuration.
		const table = page.getByRole('table');
		await expect(table).toContainText('Storgata Legesenter');
		await expect(table).toContainText('Plattformadministrasjon');
		// The platform organisation has no FHIR partition, and is not a discrepancy.
		await expect(table).not.toContainText('mangler i HAPI');
	});

	test('oppretter en virksomhet med partisjon og første systemansvarlige', async ({ page }) => {
		await logInPlatform(page);
		await page.goto(`${PLATFORM_URL}/systemadmin`);
		await waitOnHydration(page);

		await page.getByLabel('Maskinnavn').fill('legekontor-nytt');
		await page.getByLabel("Virksomhetens navn").fill('Nytt Legekontor AS');
		await page.getByLabel('Organisasjonsnummer').fill('994598759');
		await page.getByLabel('Vertsnavn').fill('nytt.epj.test');
		await page.getByLabel('Utadvendt adresse (issuer)').fill('https://nytt.epj.test');
		await page.getByLabel('Brukernavn').fill('sjefen');
		await page.getByLabel('Navn', { exact: true }).fill('Dagny Sjef');
		await page.getByRole('button', { name: 'Opprett virksomhet' }).click();

		const receipt = page.getByRole('status').filter({ hasText: 'legekontor-nytt' });
		await expect(receipt).toContainText('er opprettet med egen FHIR-partisjon');
		// The temporary password is shown once, and only here.
		await expect(receipt).toContainText('sjefen');

		// The organisation is now in the overview, with a partition that exists in HAPI.
		const row = page.getByRole('row').filter({ hasText: 'Nytt Legekontor AS' });
		await expect(row).toContainText('nytt.epj.test');
		await expect(row).toContainText('Aktiv');
		await expect(row).not.toContainText('mangler i HAPI');

		// The detail page shows the organisation's own addresses.
		await page.getByRole('link', { name: 'Nytt Legekontor AS' }).click();
		await expect(page.getByText('https://nytt.epj.test/fhir')).toBeVisible();
		await expect(
			page.getByText('https://nytt.epj.test/.well-known/smart-configuration')
		).toBeVisible();
	});

	test('avviser maskinnavn og organisasjonsnummer som ikke holder mål', async ({ page }) => {
		await logInPlatform(page);
		await page.goto(`${PLATFORM_URL}/systemadmin`);
		await waitOnHydration(page);

		// The browser stops an invalid machine name; the server checks the
		// organisation number with mod11.
		await page.getByLabel('Maskinnavn').fill('feilorgnr');
		await page.getByLabel("Virksomhetens navn").fill('Feil Orgnr AS');
		await page.getByLabel('Organisasjonsnummer').fill('123456789');
		await page.getByLabel('Utadvendt adresse (issuer)').fill('https://feil.epj.test');
		await page.getByRole('button', { name: 'Opprett virksomhet' }).click();

		await expect(page.getByRole('alert')).toContainText('mod11');
	});

	test('suspensjon stenger virksomheten umiddelbart', async ({ page }) => {
		await logInPlatform(page);
		await page.goto(`${PLATFORM_URL}/systemadmin`);
		await waitOnHydration(page);

		const row = page.getByRole('row').filter({ hasText: 'Storgata Legesenter' });
		await row.getByRole('button', { name: 'Suspender' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Status endret' })).toContainText('standard: suspendert');
		await expect(
			page.getByRole('row').filter({ hasText: 'Storgata Legesenter' })
		).toContainText('Suspendert');

		// Reactivate, so the other tests do not inherit a closed organisation.
		await page
			.getByRole('row')
			.filter({ hasText: 'Storgata Legesenter' })
			.getByRole('button', { name: 'Aktiver' })
			.click();
		await expect(page.getByRole('status').filter({ hasText: 'Status endret' })).toContainText('standard: aktiv');
	});

	test('plattformvirksomheten kan ikke suspenderes', async ({ page }) => {
		await logInPlatform(page);
		const response = await page.request.post(`${PLATFORM_URL}/systemadmin?/status`, {
			form: { id: 'plattform', status: 'suspendert' }
		});
		expect(await response.text()).toContain('kan ikke suspenderes');
	});

	test('plattformadministrasjonen finnes ikke på en virksomhets vertsnavn', async ({ page }) => {
		await logIn(page, 'lege');
		await expect(page.getByRole('link', { name: 'Plattform' })).toHaveCount(0);

		// Two bars: the hostname, and the permission.
		const paaOrganisation = await page.request.get('/systemadmin');
		expect(paaOrganisation.status()).toBe(404);
		expect(await paaOrganisation.text()).toContain('eget vertsnavn');
	});

	test('en vanlig bruker uten plattformrettighet blir avvist', async ({ page }) => {
		// The doctor exists only in the practice's organisation, not on the platform.
		await page.goto(`${PLATFORM_URL}/logg-inn`);
		await waitOnHydration(page);
		await page.getByLabel('Brukernavn').fill('lege');
		await page.getByLabel('Passord').fill('Testpassord1!');
		await page.getByLabel('Engangskode').fill('000000');
		await page.getByRole('button', { name: 'Logg inn' }).click();
		await expect(page.locator('body')).not.toContainText('Plattformadministrasjon');
	});

	test('systemeier har ingen klinisk tilgang', async ({ page }) => {
		await logInPlatform(page);

		// No record tabs in the menu, and the clinical pages do not exist on the
		// platform hostname at all.
		await expect(page.getByRole('link', { name: 'Pasienter' })).toHaveCount(0);

		const patients = await page.request.get(`${PLATFORM_URL}/pasienter`);
		expect(patients.status()).toBe(404);

		// And the role holds not one single scope, so the FHIR facade gives nothing.
		const fhir = await page.request.get(`${PLATFORM_URL}/fhir/Patient`);
		expect(fhir.ok()).toBe(false);
	});
});
