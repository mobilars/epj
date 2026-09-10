import { expect, test } from '@playwright/test';
import { logIn, logOut, totp, waitOnHydration } from './hjelpere';

test.describe('pålogging', () => {
	test('krever engangskode i tillegg til passord', async ({ page }) => {
		await page.goto('/logg-inn');
		await waitOnHydration(page);
		await page.getByLabel('Brukernavn').fill('lege');
		await page.getByLabel('Passord').fill('Testpassord1!');
		await page.getByRole('button', { name: 'Logg inn' }).click();

		await expect(page.getByRole('alert')).toContainText('Skriv inn engangskoden');
		// Ingen sesjon er opprettet uten engangskode.
		await page.goto('/');
		await expect(page).toHaveURL(/\/logg-inn/);
	});

	test('gir samme melding ved feil passord og ukjent bruker', async ({ page }) => {
		await page.goto('/logg-inn');
		await waitOnHydration(page);
		await page.getByLabel('Brukernavn').fill('lege');
		await page.getByLabel('Passord').fill('helt feil');
		await page.getByRole('button', { name: 'Logg inn' }).click();
		const errorAtErrorPassword = await page.getByRole('alert').textContent();

		await page.goto('/logg-inn');
		await waitOnHydration(page);
		await page.getByLabel('Brukernavn').fill('finnesikke');
		await page.getByLabel('Passord').fill('helt feil');
		await page.getByRole('button', { name: 'Logg inn' }).click();
		const errorAtUnknownUser = await page.getByRole('alert').textContent();

		expect(errorAtErrorPassword).toBe(errorAtUnknownUser);
	});

	test('avviser feil engangskode', async ({ page }) => {
		await page.goto('/logg-inn');
		await waitOnHydration(page);
		await page.getByLabel('Brukernavn').fill('lege');
		await page.getByLabel('Passord').fill('Testpassord1!');
		await page.getByLabel('Engangskode').fill('000000');
		await page.getByRole('button', { name: 'Logg inn' }).click();
		await expect(page.getByRole('alert')).toContainText('Feil brukernavn, passord eller engangskode');
	});

	test('logger inn og ut', async ({ page }) => {
		await logIn(page, 'lege');
		await expect(page.getByRole('heading', { name: 'Arbeidsflate' })).toBeVisible();
		await expect(page.getByText('Dr. Ingrid Fastlege')).toBeVisible();
		await logOut(page);
		await page.goto('/pasienter');
		await expect(page).toHaveURL(/\/logg-inn/);
	});

	test('sender uinnlogget bruker til pålogging og tilbake etterpå', async ({ page }) => {
		await page.goto('/oppgjor');
		await expect(page).toHaveURL(/\/logg-inn\?retur=%2Foppgjor/);
		await waitOnHydration(page);

		await page.getByLabel('Brukernavn').fill('lege');
		await page.getByLabel('Passord').fill('Testpassord1!');
		await page.getByLabel('Engangskode').fill(totp());
		await page.getByRole('button', { name: 'Logg inn' }).click();

		await expect(page).toHaveURL(/\/oppgjor$/);
	});

	test('viser miljøbanner i testmiljø', async ({ page }) => {
		await page.goto('/logg-inn');
		await expect(page.locator('.miljobanner')).toContainText('ikke bruk ekte pasientopplysninger');
	});
});
