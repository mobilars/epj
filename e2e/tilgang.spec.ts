import { expect, test } from '@playwright/test';
import { loggInn, totp, ventPaHydrering } from './hjelpere';

/**
 * Tilgangsstyring i praksis: tjenstlig behov, sperring og nødrett.
 *
 * Demodataene gir legen behandlingsrelasjon til alle pasientene, sykepleieren
 * til de to første, og Sofie Lie har sperret journalen for sykepleieren.
 */
test.describe('tilgangsstyring', () => {
	async function finnPasientId(page: import('@playwright/test').Page, navn: string): Promise<string> {
		await page.goto('/pasienter');
		await ventPaHydrering(page);
		await page.getByLabel(/Søk på navn/).fill(navn);
		await page.getByRole('button', { name: 'Søk' }).click();
		await page.getByRole('link', { name: new RegExp(navn) }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		return page.url().split('/pasienter/')[1].split(/[/?]/)[0];
	}

	test('sykepleier har ikke tilgang til pasient uten behandlingsrelasjon', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await finnPasientId(page, 'Vik');

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await loggInn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);

		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
		await expect(page.getByRole('alert')).toContainText('behandlingsrelasjon');
		// Journalinnholdet vises ikke.
		await expect(page.getByRole('heading', { name: 'Diagnoser og problemer' })).toHaveCount(0);
	});

	test('sperret journal stenger ute den sperringen gjelder', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await finnPasientId(page, 'Lie');
		await expect(page.locator('.pasientbanner')).toContainText('Sperret journal');

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await loggInn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
	});

	test('nettleseren stopper en for kort begrunnelse før den sendes', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await finnPasientId(page, 'Vik');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await loggInn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await ventPaHydrering(page);

		await page.getByLabel('Begrunnelse').fill('haster');
		await page.getByLabel('Bekreft med engangskode').fill(totp());
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();

		// Skjemaet sendes ikke, og feltet markeres som ugyldig.
		await expect(page).toHaveURL(new RegExp(`/pasienter/${id}$`));
		expect(await page.getByLabel('Begrunnelse').evaluate((e: HTMLTextAreaElement) => e.validity.tooShort)).toBe(true);
	});

	test('serveren avviser for kort begrunnelse selv om nettleserkontrollen omgås', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await finnPasientId(page, 'Vik');
		await page.getByRole('button', { name: 'Logg ut' }).click();
		await loggInn(page, 'sykepleier');

		// Sender direkte til handlingen, uten skjemaet - slik en angriper ville gjort.
		// page.request deler informasjonskapsler med nettleseren, slik at kallet
		// gjøres som den innloggede sykepleieren.
		const svar = await page.request.post(`/pasienter/${id}/nodrett?/nodrett`, {
			headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
			form: { begrunnelse: 'kort', engangskode: totp() },
			maxRedirects: 0
		});
		expect(svar.status()).toBe(303);
		expect(svar.headers()['location']).toContain('nodrettFeil=');
		expect(decodeURIComponent(svar.headers()['location'])).toContain('minst 15 tegn');

		// Ingen tilgang er gitt.
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
	});

	test('nødrett krever riktig engangskode, og gir deretter tydelig merket tilgang', async ({ page }) => {
		await loggInn(page, 'lege');
		const id = await finnPasientId(page, 'Vik');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await loggInn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await ventPaHydrering(page);

		const begrunnelse = 'Akutt situasjon, pasienten er ikke i stand til å samtykke.';

		await page.getByLabel('Begrunnelse').fill(begrunnelse);
		await page.getByLabel('Bekreft med engangskode').fill('000000');
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();
		await expect(page.getByText('Feil eller manglende engangskode')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();

		await ventPaHydrering(page);
		await page.getByLabel('Begrunnelse').fill(begrunnelse);
		await page.getByLabel('Bekreft med engangskode').fill(totp());
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();

		await expect(page.locator('.pasientbanner')).toContainText('Nødrettstilgang aktiv');
		await expect(page.getByText('gjennomgått av ledelsen')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Diagnoser og problemer' })).toBeVisible();
	});

	test('nødrettsoppslag havner i loggen og på oversikten til systemansvarlig', async ({ page }) => {
		// Sofie Lie har sperret journalen for sykepleieren. Nødrett overstyrer
		// sperringen, og oppslaget skal da være særlig godt sporet.
		await loggInn(page, 'lege');
		const id = await finnPasientId(page, 'Lie');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await loggInn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await ventPaHydrering(page);
		await page.getByLabel('Begrunnelse').fill('Pasienten er bevisstløs og trenger øyeblikkelig hjelp.');
		await page.getByLabel('Bekreft med engangskode').fill(totp());
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();
		await expect(page.locator('.pasientbanner')).toContainText('Nødrettstilgang aktiv');

		await page.goto(`/pasienter/${id}/logg`);
		await expect(page.getByText('Nødrett').first()).toBeVisible();

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await loggInn(page, 'admin');
		await page.goto('/admin');
		await expect(page.getByRole('heading', { name: 'Nødrettsoppslag til gjennomgang' })).toBeVisible();
		await expect(page.getByText('Kari Sykepleier').first()).toBeVisible();
	});

	test('helsesekretær kan se pasienten, men ikke skrive journalnotat', async ({ page }) => {
		await loggInn(page, 'sekretaer');
		await page.goto('/pasienter');
		await ventPaHydrering(page);
		await page.getByRole('link', { name: /Bakken/ }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		const id = page.url().split('/pasienter/')[1].split(/[/?]/)[0];

		await page.goto(`/pasienter/${id}/notater`);
		await expect(page.getByRole('heading', { name: 'Nytt notat' })).toHaveCount(0);
	});

	test('systemansvarlig har ingen klinisk tilgang', async ({ page }) => {
		await loggInn(page, 'admin');
		await expect(page.getByRole('link', { name: 'Pasienter' })).toHaveCount(0);
		await page.goto('/pasienter');
		await expect(page.locator('body')).toContainText('ikke tilgang til pasientopplysninger');
	});

	test('personvernombudet kommer til sikkerhetsloggen og ser at kjeden er hel', async ({ page }) => {
		await loggInn(page, 'ombud');
		await page.goto('/admin/logg');
		await expect(page.getByRole('heading', { name: 'Sikkerhetslogg' })).toBeVisible();
		await expect(page.getByText('Hash-kjeden er ubrutt')).toBeVisible();
	});
});
