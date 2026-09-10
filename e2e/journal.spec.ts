import { expect, test } from '@playwright/test';
import { openFirstPatient, logIn, waitOnHydration } from './hjelpere';

test.describe('journal', () => {
	test.beforeEach(async ({ page }) => {
		await logIn(page, 'lege');
	});

	test('viser mine pasienter og lar meg søke', async ({ page }) => {
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await expect(page.getByRole('heading', { name: 'Pasienter', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: /Bakken/ })).toBeVisible();

		await page.getByLabel(/Søk på navn/).fill('Nordli');
		await page.getByRole('button', { name: 'Søk' }).click();
		await expect(page.getByRole('link', { name: /Nordli/ })).toBeVisible();
		await expect(page.getByRole('link', { name: /Bakken/ })).toHaveCount(0);
	});

	test('avviser søk på ugyldig fødselsnummer', async ({ page }) => {
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByLabel(/Søk på navn/).fill('13086510036');
		await page.getByRole('button', { name: 'Søk' }).click();
		await expect(page.getByText('Ugyldig fødselsnummer')).toBeVisible();
	});

	test('viser pasientbanner og klinisk oversikt', async ({ page }) => {
		await openFirstPatient(page);
		const banner = page.locator('.pasientbanner');
		await expect(banner).toContainText('Anne Bakken');
		await expect(banner).toContainText('130865*****');

		await expect(page.getByRole('heading', { name: 'Diagnoser og problemer' })).toBeVisible();
		await expect(page.getByText('Hypertensjon ukomplisert')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Kritisk informasjon' })).toBeVisible();
		await expect(page.getByText('Penicillin')).toBeVisible();
	});

	test('skriver et journalnotat som blir liggende i journalen', async ({ page }) => {
		const id = await openFirstPatient(page);
		await page.goto(`/pasienter/${id}/notater`);

		await page.getByLabel('Tittel').fill('Kontroll av blodtrykk');
		await page.getByLabel('Subjektivt').fill('Pasienten forteller om lett hodepine siste uke.');
		await page.getByLabel('Objektivt').fill('BT 148/92. Ellers upåfallende.');
		await page.getByLabel('Vurdering og plan').fill('Fortsetter uendret behandling. Kontroll om tre måneder.');
		await page.getByLabel('Kode').fill('K86');
		await page.getByLabel('Tekst').fill('Hypertensjon ukomplisert');
		await page.getByRole('button', { name: 'Lagre notat' }).click();

		await expect(page.getByRole('heading', { name: 'Kontroll av blodtrykk' })).toBeVisible();
		await expect(page.getByText('lett hodepine siste uke')).toBeVisible();

		// Notatet er en del av journalen og vises i oversikten.
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByText('Kontroll av blodtrykk')).toBeVisible();
	});

	test('feilfører et notat i stedet for å slette det', async ({ page }) => {
		const id = await openFirstPatient(page);
		await page.goto(`/pasienter/${id}/notater`);
		await page.getByLabel('Tittel').fill('Notat som skal feilføres');
		await page.getByLabel('Subjektivt').fill('Ført på feil pasient.');
		await page.getByRole('button', { name: 'Lagre notat' }).click();

		await page.getByText('Merk som feilført').first().click();
		await page.getByLabel('Begrunnelse').first().fill('Ført på feil pasient ved en forveksling.');
		await page.getByRole('button', { name: 'Merk som feilført' }).first().click();

		await expect(page.getByText('Feilført').first()).toBeVisible();
		// Innholdet er fortsatt der - journalen skal ikke miste spor.
		await expect(page.getByText('Ført på feil pasient.')).toBeVisible();
	});

	test('forskriver et legemiddel gjennom SFM', async ({ page }) => {
		const id = await openFirstPatient(page);
		await page.goto(`/pasienter/${id}/legemidler`);

		await page.getByLabel('Legemiddel', { exact: true }).fill('Metformin');
		await page.getByLabel('ATC-kode').fill('A10BA02');
		await page.getByLabel('Styrke').fill('500 mg');
		await page.getByLabel('Dosering').fill('1 tablett morgen og kveld');
		await page.getByRole('button', { name: 'Forskriv' }).click();

		await expect(page.locator('main').getByRole('status')).toContainText('sendt til e-resept');
		await expect(page.getByText('Metformin 500 mg')).toBeVisible();
	});

	test('varsler om alvorlig interaksjon', async ({ page }) => {
		const id = await openFirstPatient(page);
		await page.goto(`/pasienter/${id}/legemidler`);

		for (const [name, atc] of [['Warfarin', 'B01AA03'], ['Ibux', 'M01AE01']]) {
				await page.getByLabel('Legemiddel', { exact: true }).fill(name);
			await page.getByLabel('ATC-kode').fill(atc);
			await page.getByLabel('Dosering').fill('etter behov');
			await page.getByRole('button', { name: 'Forskriv' }).click();
		}

		const alert = page.locator('main').getByRole('status');
		await expect(alert).toContainText('ALVORLIG');
		await expect(alert).toContainText('blødningsrisiko');
	});

	test('viser innsynsloggen for pasienten', async ({ page }) => {
		const id = await openFirstPatient(page);
		await page.goto(`/pasienter/${id}/logg`);
		await expect(page.getByRole('heading', { name: 'Innsynslogg' })).toBeVisible();
		await expect(page.getByText('Dr. Ingrid Fastlege').first()).toBeVisible();
	});
});
