import { expect, test } from '@playwright/test';
import { apneForstePasient, loggInn, ventPaHydrering } from './hjelpere';

/**
 * Utlevering av journal, sett fra brukeren.
 *
 * Det som prøves her er hele veien fra skjemaet til den ferdige filen: at
 * legen finner funksjonen, at nedlastingen faktisk kommer, at innholdet er
 * pasientens eget, og at utleveringen etterpå står i sikkerhetsloggen.
 */
test.describe('utlevering av journal', () => {
	test('legen kan laste ned en lesbar journalutskrift', async ({ page }) => {
		await loggInn(page, 'lege');
		const patientId = await apneForstePasient(page);

		await page.getByRole('link', { name: 'Utlevering' }).click();
		await ventPaHydrering(page);
		await expect(page.getByRole('heading', { name: 'Utlevering av journal' })).toBeVisible();

		await page.getByLabel('Utleveres til').fill('Pasienten selv');
		const nedlasting = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Lag og last ned' }).click();
		const fil = await nedlasting;

		expect(fil.suggestedFilename()).toMatch(/^journal-anne-bakken-\d{4}-\d{2}-\d{2}\.html$/);

		const strom = await fil.createReadStream();
		const biter: Buffer[] = [];
		for await (const b of strom) biter.push(b as Buffer);
		const html = Buffer.concat(biter).toString('utf8');

		expect(html).toContain('Utskrift av pasientjournal');
		expect(html).toContain('Anne Bakken');
		expect(html).toContain('Pasienten selv');
		expect(html).toContain('Hypertensjon ukomplisert');
		expect(html).toContain('Innsyn etter pasient- og brukerrettighetsloven § 5-1');
		// Utskriften skal kunne åpnes hvor som helst, uten å hente noe utenfra.
		expect(html).not.toMatch(/<script/i);

		// Utleveringen skal stå i pasientens innsynslogg.
		await page.goto(`/pasienter/${patientId}/logg`);
		await expect(page.getByText('utlevering').first()).toBeVisible();
	});

	test('gir FHIR-dokument når det formatet velges', async ({ page }) => {
		await loggInn(page, 'lege');
		await apneForstePasient(page);
		await page.getByRole('link', { name: 'Utlevering' }).click();
		await ventPaHydrering(page);

		await page.getByRole('radio', { name: /Overføring til annen behandler/ }).check();
		await page.getByRole('radio', { name: /FHIR-dokument/ }).check();

		const nedlasting = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Lag og last ned' }).click();
		const fil = await nedlasting;
		expect(fil.suggestedFilename()).toMatch(/\.json$/);

		const strom = await fil.createReadStream();
		const biter: Buffer[] = [];
		for await (const b of strom) biter.push(b as Buffer);
		const dokument = JSON.parse(Buffer.concat(biter).toString('utf8'));

		expect(dokument.resourceType).toBe('Bundle');
		expect(dokument.type).toBe('document');
		expect(dokument.entry[0].resource.resourceType).toBe('Composition');
		expect(dokument.entry[0].resource.title).toContain('Anne Bakken');
	});

	test('viser tidligere utleveringer på pasienten', async ({ page }) => {
		await loggInn(page, 'lege');
		const patientId = await apneForstePasient(page);

		// Første utlevering.
		const svar = await page.request.get(
			`/pasienter/${patientId}/utlevering/last-ned?format=txt&grunn=rettslig&mottaker=Tingretten`
		);
		expect(svar.ok()).toBe(true);
		expect(await svar.text()).toContain('Utlevering på rettslig grunnlag');

		await page.goto(`/pasienter/${patientId}/utlevering`);
		await ventPaHydrering(page);
		const tabell = page.getByRole('table');
		await expect(tabell).toContainText('rettslig');
		await expect(tabell).toContainText('HLEGAL');
	});

	test('roller uten utleveringsrett kommer ikke til', async ({ page }) => {
		await loggInn(page, 'sykepleier');
		const patientId = await apneForstePasient(page);

		await expect(page.getByRole('link', { name: 'Utlevering' })).toHaveCount(0);

		const svar = await page.request.get(`/pasienter/${patientId}/utlevering/last-ned?format=json`);
		expect(svar.status()).toBe(403);
	});

	test('avviser ugyldig datoavgrensning', async ({ page }) => {
		await loggInn(page, 'lege');
		const patientId = await apneForstePasient(page);
		const svar = await page.request.get(
			`/pasienter/${patientId}/utlevering/last-ned?format=txt&fra=i-fjor`
		);
		expect(svar.status()).toBe(400);
	});
});
