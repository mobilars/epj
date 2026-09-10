import { expect, test } from '@playwright/test';
import { openFirstPatient, logIn, waitOnHydration } from './hjelpere';

/**
 * Disclosure of the record, seen from the user.
 *
 * What is exercised is the whole way from the form to the finished file: that
 * the doctor finds the function, that the download arrives, that the content is
 * the patient's own, and that the disclosure afterwards appears in the log.
 */
test.describe('utlevering av journal', () => {
	test('legen kan laste ned en lesbar journalutskrift', async ({ page }) => {
		await logIn(page, 'lege');
		const patientId = await openFirstPatient(page);

		await page.getByRole('link', { name: 'Utlevering' }).click();
		await waitOnHydration(page);
		await expect(page.getByRole('heading', { name: 'Utlevering av journal' })).toBeVisible();

		await page.getByLabel('Utleveres til').fill('Pasienten selv');
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Lag og last ned' }).click();
		const file = await download;

		expect(file.suggestedFilename()).toMatch(/^journal-anne-bakken-\d{4}-\d{2}-\d{2}\.html$/);

		const strom = await file.createReadStream();
		const biter: Buffer[] = [];
		for await (const b of strom) biter.push(b as Buffer);
		const html = Buffer.concat(biter).toString('utf8');

		expect(html).toContain('Utskrift av pasientjournal');
		expect(html).toContain('Anne Bakken');
		expect(html).toContain('Pasienten selv');
		expect(html).toContain('Hypertensjon ukomplisert');
		expect(html).toContain('Innsyn etter pasient- og brukerrettighetsloven § 5-1');
		// The printout must open anywhere, without fetching anything externally.
		expect(html).not.toMatch(/<script/i);

		// The disclosure must appear in the patient's access log.
		await page.goto(`/pasienter/${patientId}/logg`);
		await expect(page.getByText('utlevering').first()).toBeVisible();
	});

	test('gir FHIR-dokument når det formatet velges', async ({ page }) => {
		await logIn(page, 'lege');
		await openFirstPatient(page);
		await page.getByRole('link', { name: 'Utlevering' }).click();
		await waitOnHydration(page);

		await page.getByRole('radio', { name: /Overføring til annen behandler/ }).check();
		await page.getByRole('radio', { name: /FHIR-dokument/ }).check();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Lag og last ned' }).click();
		const file = await download;
		expect(file.suggestedFilename()).toMatch(/\.json$/);

		const strom = await file.createReadStream();
		const biter: Buffer[] = [];
		for await (const b of strom) biter.push(b as Buffer);
		const document = JSON.parse(Buffer.concat(biter).toString('utf8'));

		expect(document.resourceType).toBe('Bundle');
		expect(document.type).toBe('document');
		expect(document.entry[0].resource.resourceType).toBe('Composition');
		expect(document.entry[0].resource.title).toContain('Anne Bakken');
	});

	test('viser tidligere utleveringer på pasienten', async ({ page }) => {
		await logIn(page, 'lege');
		const patientId = await openFirstPatient(page);

		// First disclosure.
		const response = await page.request.get(
			`/pasienter/${patientId}/utlevering/last-ned?format=txt&grunn=rettslig&mottaker=Tingretten`
		);
		expect(response.ok()).toBe(true);
		expect(await response.text()).toContain('Utlevering på rettslig grunnlag');

		await page.goto(`/pasienter/${patientId}/utlevering`);
		await waitOnHydration(page);
		const table = page.getByRole('table');
		await expect(table).toContainText('rettslig');
		await expect(table).toContainText('HLEGAL');
	});

	test('roller uten utleveringsrett kommer ikke til', async ({ page }) => {
		await logIn(page, 'sykepleier');
		const patientId = await openFirstPatient(page);

		await expect(page.getByRole('link', { name: 'Utlevering' })).toHaveCount(0);

		const response = await page.request.get(`/pasienter/${patientId}/utlevering/last-ned?format=json`);
		expect(response.status()).toBe(403);
	});

	test('avviser ugyldig datoavgrensning', async ({ page }) => {
		await logIn(page, 'lege');
		const patientId = await openFirstPatient(page);
		const response = await page.request.get(
			`/pasienter/${patientId}/utlevering/last-ned?format=txt&fra=i-fjor`
		);
		expect(response.status()).toBe(400);
	});
});
