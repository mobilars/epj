import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { logIn, waitOnHydration } from './hjelpere';

/**
 * The demo apps, really launched against the record.
 *
 * Nginx serves them in production, choosing the page by hostname. Here the browser's
 * requests for the one registered test app's address are answered from the files on
 * disk, so what runs is the real page and the real SMART launch.
 */
const DIRECTORY = join('deploy', 'apus', 'demo-app');
const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css', html: 'text/html' };

async function launch(page: Page, file: string, patient: RegExp): Promise<void> {
	await page.route('http://localhost:4000/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		const shared = /^\/[\w-]+\.(js|css)$/.test(path);
		const name = shared ? path.slice(1) : file;
		route.fulfill({
			contentType: TYPES[name.split('.').pop() as string],
			headers: { 'cache-control': 'no-store' },
			body: readFileSync(join(DIRECTORY, name))
		});
	});

	await logIn(page, 'lege');
	await page.goto('/pasienter');
	await waitOnHydration(page);
	await page.getByRole('link', { name: patient }).first().click();
	await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
	const id = page.url().split('/pasienter/')[1].split(/[/?]/)[0];
	await page.goto(`/pasienter/${id}/apper`);
	await waitOnHydration(page);
	const clientId = ((await page.getByTestId('client-id').first().textContent()) as string).trim();
	await page.getByRole('button', { name: 'Start app' }).first().click();
	const href = (await page.getByRole('link', { name: 'Åpne appen' }).getAttribute('href')) as string;
	const url = new URL(href);
	url.searchParams.set('client_id', clientId);
	await page.goto(url.toString());

	const consent = page.getByRole('button', { name: 'Gi tilgang' });
	await consent.or(page.locator('main h1')).first().waitFor();
	if (await consent.isVisible()) await consent.click();
}

// A page answered by the test counts as public to Chrome, which then refuses it the
// record on localhost. In production both are ordinary sites.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] } });

test.describe('demo apps', () => {
	test('Diabetesoversikt shows the measurements and the diagnosis', async ({ page }) => {
		await launch(page, 'diabetes.html', /Bakken/);
		await expect(page.getByRole('heading', { name: 'Diabetesoversikt' })).toBeVisible();
		await expect(page.locator('strong', { hasText: '58 mmol/mol' })).toBeVisible();
		await expect(page.locator('strong', { hasText: '148 mm[Hg]' })).toBeVisible();
		await expect(page.locator('svg').first()).toBeVisible();
		await expect(page.getByText('Ingen diabetesdiagnose')).toHaveCount(0);
	});

	test('Diabetesoversikt adds a diagnosis and medicines as example data, and takes them out', async ({ page }) => {
		page.on('dialog', (dialog) => dialog.accept());
		await launch(page, 'diabetes.html', /Lie/);
		await expect(page.getByText('Ingen diabetesdiagnose')).toBeVisible();

		await page.getByRole('button', { name: 'Legg inn eksempeldata' }).click();
		await expect(page.getByText('Metformin 500 mg')).toBeVisible();
		await expect(page.getByText('Ingen diabetesdiagnose')).toHaveCount(0);
		await expect(page.locator('strong', { hasText: '52 mmol/mol' })).toBeVisible();
		await expect(page.getByText('oppdiktet eksempeldata')).toBeVisible();

		await page.getByRole('button', { name: 'Fjern eksempeldata' }).click();
		await expect(page.getByText('Ingen diabetesdiagnose')).toBeVisible();
		await expect(page.getByText('Metformin 500 mg')).toHaveCount(0);
	});

	test('Journalnotat finds a diagnosis from everyday words', async ({ page }) => {
		await launch(page, 'notat.html', /Bakken/);
		await page.getByLabel('ICPC-2: kode eller søkeord').pressSequentially('høyt blodtrykk');
		const hit = page.getByRole('button', { name: /K86/ }).first();
		await expect(hit).toBeVisible();
		await hit.click();
		await expect(page.getByLabel('ICPC-2: kode eller søkeord')).toHaveValue('K86');
		await expect(page.getByLabel('Diagnosetekst')).toHaveValue(/Hypertensjon/);
		await expect(page.getByRole('button', { name: /K86/ })).toHaveCount(0);
	});

	test('Hjerterisiko fills in what the record knows, and calculates when the rest is given', async ({ page }) => {
		await launch(page, 'hjerterisiko.html', /Bakken/);
		await expect(page.getByRole('heading', { name: 'Hjerterisiko' })).toBeVisible();
		await expect(page.getByLabel('Systolisk blodtrykk')).toHaveValue('148');
		await expect(page.getByLabel('Diabetes')).toBeChecked();
		await expect(page.getByText('Fyll inn blodtrykk og kolesterol')).toBeVisible();

		await page.getByLabel('Totalkolesterol').fill('5.5');
		await page.getByLabel('HDL-kolesterol').fill('1.3');
		await expect(page.locator('#resultat')).toContainText(/\d+,\d %/);
		await expect(page.getByText('ikke NORRISK 2')).toBeVisible();
	});

	test('Vekstkurve draws example data, labelled in the record too, and takes it out again', async ({ page }) => {
		page.on('dialog', (dialog) => dialog.accept());
		await launch(page, 'vekst.html', /Emma/);
		await expect(page.getByRole('heading', { name: 'Vekstkurve' })).toBeVisible();
		await expect(page.getByText('Ingen målinger av høyde.')).toBeVisible();

		await page.getByRole('button', { name: 'Legg inn eksempeldata' }).click();
		await expect(page.getByText('Ingen målinger av høyde.')).toHaveCount(0);
		await expect(page.getByText('oppdiktet eksempeldata')).toBeVisible();
		await expect(page.getByText(/KMI \d/)).toBeVisible();
		const appUrl = page.url();

		// The record says so as well.
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Emma/ }).first().click();
		await expect(page.locator('.kort', { hasText: 'Siste målinger' }).getByText('Eksempeldata').first()).toBeVisible();

		await page.goto(appUrl);
		await page.getByRole('button', { name: 'Fjern eksempeldata' }).click();
		await expect(page.getByText('Ingen målinger av høyde.')).toBeVisible();

		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Emma/ }).first().click();
		await expect(page.locator('.kort', { hasText: 'Siste målinger' })).toBeVisible();
		await expect(page.locator('.kort', { hasText: 'Siste målinger' }).getByText('Eksempeldata')).toHaveCount(0);
	});

	test('Hjerterisiko can fill itself from example data, and leaves real measurements alone', async ({ page }) => {
		page.on('dialog', (dialog) => dialog.accept());
		await launch(page, 'hjerterisiko.html', /Bakken/);
		await page.getByRole('button', { name: 'Legg inn eksempeldata' }).click();
		await expect(page.getByLabel('Totalkolesterol')).toHaveValue('5.8');
		await expect(page.locator('#resultat')).toContainText(/\d+,\d %/);

		await page.getByRole('button', { name: 'Fjern eksempeldata' }).click();
		await expect(page.getByLabel('Totalkolesterol')).toHaveValue('');
		await expect(page.getByLabel('Systolisk blodtrykk')).toHaveValue('148');
	});
});
