import { expect, test } from '@playwright/test';
import { logIn, logInPlatform, PLATFORM_URL, waitOnHydration } from './hjelpere';

/**
 * Plattformadministrasjonen.
 *
 * Testene her prøver den delen som ikke lar seg dekke av enhetstestene: at
 * grensesnittet faktisk oppretter en virksomhet med partisjon, at det avviser
 * det som skal avvises, og - viktigst - at ingen andre enn systemeier kommer inn.
 *
 * Plattformen har sitt eget vertsnavn. I testmiljøet peker `localhost` og
 * `127.0.0.1` på den samme serveren, slik at begge virksomhetene kan nås uten
 * at testene trenger DNS.
 */
test.describe('plattformadministrasjon', () => {
	test('systemeier ser virksomhetene og partisjonstilstanden', async ({ page }) => {
		await logInPlatform(page);

		// Systemeier har ingen klinisk arbeidsflate, og sendes rett til plattformen.
		await expect(page).toHaveURL(/\/systemadmin$/);
		await expect(page.getByRole('heading', { name: 'Plattformadministrasjon' })).toBeVisible();

		// Standardvirksomheten har fått navn og adresse fra konfigurasjonen.
		const table = page.getByRole('table');
		await expect(table).toContainText('Storgata Legesenter');
		await expect(table).toContainText('Plattformadministrasjon');
		// Plattformvirksomheten har ingen FHIR-partisjon, og skal ikke meldes som avvik.
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
		// Det midlertidige passordet vises én gang, og bare her.
		await expect(receipt).toContainText('sjefen');

		// Virksomheten er nå i oversikten, med en partisjon som finnes i HAPI.
		const row = page.getByRole('row').filter({ hasText: 'Nytt Legekontor AS' });
		await expect(row).toContainText('nytt.epj.test');
		await expect(row).toContainText('Aktiv');
		await expect(row).not.toContainText('mangler i HAPI');

		// Detaljsiden viser virksomhetens egne adresser.
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

		// Nettleseren stopper et ugyldig maskinnavn; serveren kontrollerer
		// organisasjonsnummeret med mod11.
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

		// Aktiver igjen, slik at de andre testene ikke arver en stengt virksomhet.
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

		// To sperrer: vertsnavnet, og rettigheten.
		const paaOrganisation = await page.request.get('/systemadmin');
		expect(paaOrganisation.status()).toBe(404);
		expect(await paaOrganisation.text()).toContain('eget vertsnavn');
	});

	test('en vanlig bruker uten plattformrettighet blir avvist', async ({ page }) => {
		// Legen finnes bare i legekontorets virksomhet, ikke på plattformen.
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

		// Ingen journalfaner i menyen, og de kliniske sidene finnes ikke på
		// plattformens vertsnavn i det hele tatt.
		await expect(page.getByRole('link', { name: 'Pasienter' })).toHaveCount(0);

		const patients = await page.request.get(`${PLATFORM_URL}/pasienter`);
		expect(patients.status()).toBe(404);

		// Og rollen har ikke ett eneste scope, så FHIR-fasaden gir ingenting.
		const fhir = await page.request.get(`${PLATFORM_URL}/fhir/Patient`);
		expect(fhir.ok()).toBe(false);
	});
});
