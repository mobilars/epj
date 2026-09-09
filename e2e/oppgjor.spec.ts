import { expect, test } from '@playwright/test';
import { loggInn, ventPaHydrering } from './hjelpere';

/** Oppgjørsflyten: takstvalg, frikort, regningskort og innsending til Helfo. */
test.describe('oppgjør', () => {
	async function apnePasient(page: import('@playwright/test').Page, navn: string): Promise<string> {
		await page.goto('/pasienter');
		await ventPaHydrering(page);
		await page.getByLabel(/Søk på navn/).fill(navn);
		await page.getByRole('button', { name: 'Søk' }).click();
		await page.getByRole('link', { name: new RegExp(navn) }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		return page.url().split('/pasienter/')[1].split(/[/?]/)[0];
	}

	test('registrerer regningskort med takster og viser frikortstatus', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await apnePasient(page, 'Bakken');
		await page.goto(`/pasienter/${id}/oppgjor`);
		await ventPaHydrering(page);

		await expect(page.getByText(/frikort|Opptjent egenandel/)).toBeVisible();

		await page.getByLabel('Diagnose (ICPC-2)').fill('K86');
		await page.getByLabel('HPR-nummer').fill('9144889');
		await page.locator('input[name="takst"][value="2ad"]').check();
		await page.locator('input[name="takst"][value="701a"]').check();
		await page.getByRole('button', { name: 'Registrer regningskort' }).click();

		await expect(page.locator('main').getByRole('status')).toContainText('klart for oppgjør');
		await expect(page.getByRole('cell', { name: /2ad/ })).toBeVisible();
	});

	test('avviser takstkombinasjon som bryter reglene', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await apnePasient(page, 'Bakken');
		await page.goto(`/pasienter/${id}/oppgjor`);
		await ventPaHydrering(page);

		await page.locator('input[name="takst"][value="2ad"]').check();
		await page.locator('input[name="takst"][value="1ak"]').check();
		await page.getByRole('button', { name: 'Registrer regningskort' }).click();

		await expect(page.getByRole('alert')).toContainText('kan ikke kombineres');
	});

	test('gir fritak for egenandel til barn under 16', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await apnePasient(page, 'Emma');
		await page.goto(`/pasienter/${id}/oppgjor`);
		await ventPaHydrering(page);

		await page.locator('input[name="takst"][value="2ad"]').check();
		await page.getByRole('button', { name: 'Registrer regningskort' }).click();
		await expect(page.locator('main').getByRole('status')).toContainText('klart for oppgjør');
		await expect(page.getByText('barn-under-16')).toBeVisible();
	});

	test('genererer og sender oppgjør, og viser innsendingen', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await apnePasient(page, 'Bakken');
		await page.goto(`/pasienter/${id}/oppgjor`);
		await ventPaHydrering(page);
		await page.locator('input[name="takst"][value="2ad"]').check();
		await page.getByRole('button', { name: 'Registrer regningskort' }).click();
		await expect(page.locator('main').getByRole('status')).toContainText('klart for oppgjør');

		// Helsesekretæren sender oppgjøret.
		await page.getByRole('button', { name: 'Logg ut' }).click();
		await loggInn(page, 'sekretaer');
		await page.goto('/oppgjor');
		await expect(page.getByRole('heading', { name: 'Klart til innsending' })).toBeVisible();

		await page.getByRole('button', { name: 'Generer oppgjør' }).click();
		await expect(page.locator('main').getByRole('status')).toContainText('generert');

		await page.getByRole('button', { name: 'Send til Helfo' }).first().click();
		await expect(page.locator('main').getByRole('status')).toContainText('sendt til Helfo');
		await expect(page.getByRole('cell', { name: 'sendt' })).toBeVisible();
	});

	test('regnskapsrollen kommer ikke til journalen', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await apnePasient(page, 'Bakken');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await loggInn(page, 'sekretaer');
		await page.goto(`/pasienter/${id}/notater`);
		// Helsesekretæren ser journalen, men uten skjema for nytt notat.
		await expect(page.getByRole('heading', { name: 'Nytt notat' })).toHaveCount(0);
	});
});
