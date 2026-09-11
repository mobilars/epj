import { expect, test } from '@playwright/test';
import { logIn, totp, waitOnHydration } from './hjelpere';

/**
 * Access control in practice: legitimate need, restriction and emergency access.
 *
 * The demo data gives the doctor a care relationship with every patient, the
 * nurse with the first two, and Sofie Lie has blocked the record for the nurse.
 */
test.describe('tilgangsstyring', () => {
	async function findPatientId(page: import('@playwright/test').Page, name: string): Promise<string> {
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByLabel(/Søk på navn/).fill(name);
		await page.getByRole('button', { name: 'Søk' }).click();
		await page.getByRole('link', { name: new RegExp(name) }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		return page.url().split('/pasienter/')[1].split(/[/?]/)[0];
	}

	test('sykepleier har ikke tilgang til pasient uten behandlingsrelasjon', async ({ page }) => {
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Vik');

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);

		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
		await expect(page.getByRole('alert')).toContainText('behandlingsrelasjon');
		// The record content is not shown.
		await expect(page.getByRole('heading', { name: 'Diagnoser og problemer' })).toHaveCount(0);
	});

	test('sperret journal stenger ute den sperringen gjelder', async ({ page }) => {
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Lie');
		await expect(page.locator('.pasientbanner')).toContainText('Sperret journal');

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
	});

	test('nettleseren stopper en for kort begrunnelse før den sendes', async ({ page }) => {
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Vik');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await waitOnHydration(page);

		await page.getByLabel('Begrunnelse').fill('haster');
		await page.getByLabel('Bekreft med engangskode').fill(totp());
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();

		// The form is not submitted, and the field is marked invalid.
		await expect(page).toHaveURL(new RegExp(`/pasienter/${id}$`));
		expect(await page.getByLabel('Begrunnelse').evaluate((e: HTMLTextAreaElement) => e.validity.tooShort)).toBe(true);
	});

	test('serveren avviser for kort begrunnelse selv om nettleserkontrollen omgås', async ({ page }) => {
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Vik');
		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'sykepleier');

		// Posts straight to the action, without the form - as an attacker would.
		// page.request shares cookies with the browser, so the call is made as the
		// signed-in nurse.
		const response = await page.request.post(`/pasienter/${id}/nodrett?/emergencyAccess`, {
			headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
			form: { begrunnelse: 'kort', engangskode: totp() },
			maxRedirects: 0
		});
		expect(response.status()).toBe(303);
		expect(response.headers()['location']).toContain('nodrettFeil=');
		expect(decodeURIComponent(response.headers()['location'])).toContain('minst 15 tegn');

		// No access has been granted.
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
	});

	test('nødrett krever riktig engangskode, og gir deretter tydelig merket tilgang', async ({ page }) => {
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Vik');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await waitOnHydration(page);

		const justification = 'Akutt situasjon, pasienten er ikke i stand til å samtykke.';

		await page.getByLabel('Begrunnelse').fill(justification);
		await page.getByLabel('Bekreft med engangskode').fill('000000');
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();
		await expect(page.getByText('Feil eller manglende engangskode')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();

		await waitOnHydration(page);
		await page.getByLabel('Begrunnelse').fill(justification);
		await page.getByLabel('Bekreft med engangskode').fill(totp());
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();

		await expect(page.locator('.pasientbanner')).toContainText('Nødrettstilgang aktiv');
		await expect(page.getByText('gjennomgått av ledelsen')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Diagnoser og problemer' })).toBeVisible();
	});

	test('nødrettsoppslag havner i loggen og på oversikten til systemansvarlig', async ({ page }) => {
		// Sofie Lie has blocked the record for the nurse. Emergency access overrides
		// the restriction, and the lookup must then be especially well traced.
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Lie');
		await page.getByRole('button', { name: 'Logg ut' }).click();

		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await waitOnHydration(page);
		await page.getByLabel('Begrunnelse').fill('Pasienten er bevisstløs og trenger øyeblikkelig hjelp.');
		await page.getByLabel('Bekreft med engangskode').fill(totp());
		await page.getByRole('button', { name: 'Åpne journalen på nødrett' }).click();
		await expect(page.locator('.pasientbanner')).toContainText('Nødrettstilgang aktiv');

		await page.goto(`/pasienter/${id}/logg`);
		await expect(page.getByText('Nødrett').first()).toBeVisible();

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'admin');
		await page.goto('/admin');
		await expect(page.getByRole('heading', { name: 'Nødrettsoppslag til gjennomgang' })).toBeVisible();
		await expect(page.getByText('Kari Sykepleier').first()).toBeVisible();
	});

	test('legen kan registrere og oppheve en sperring, og den virker med en gang', async ({ page }) => {
		// The nurse has a care relationship with Nordli and no restriction. The
		// doctor blocks the record for the nurse, who then loses access; lifting
		// it gives the access back.
		await logIn(page, 'lege');
		const id = await findPatientId(page, 'Nordli');
		await page.getByRole('link', { name: 'Sperring' }).click();
		await expect(page.getByRole('heading', { name: 'Sperring av journalen' })).toBeVisible();
		await expect(page.getByText('Journalen har ingen sperringer.')).toBeVisible();
		await waitOnHydration(page);

		await page.getByLabel('En bestemt bruker').check();
		await page.getByLabel('Bruker').selectOption({ label: 'Kari Sykepleier' });
		await page.getByLabel('Hva har pasienten bedt om?').fill('Pasienten ønsker ikke at Kari skal lese journalen.');
		await page.getByRole('button', { name: 'Registrer sperring' }).click();
		await expect(page.getByText('Hele journalen, for Kari Sykepleier')).toBeVisible();
		await expect(page.locator('.pasientbanner')).toContainText('Sperret journal');

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByRole('heading', { name: 'Ingen tilgang til journalen' })).toBeVisible();
		// The nurse cannot manage restrictions.
		await page.goto(`/pasienter/${id}/sperring`);
		await expect(page.getByText('kan ikke registrere sperringer')).toBeVisible();

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'lege');
		await page.goto(`/pasienter/${id}/sperring`);
		await waitOnHydration(page);
		await page.getByText('Opphev sperringen').click();
		await page.getByLabel('Hvorfor oppheves sperringen?').fill('Pasienten har trukket ønsket tilbake.');
		await page.getByRole('button', { name: 'Opphev' }).click();
		await expect(page.getByText('Journalen har ingen sperringer.')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Opphevede sperringer' })).toBeVisible();

		await page.getByRole('button', { name: 'Logg ut' }).click();
		await logIn(page, 'sykepleier');
		await page.goto(`/pasienter/${id}`);
		await expect(page.getByRole('heading', { name: 'Diagnoser og problemer' })).toBeVisible();
	});

	test('helsesekretær kan se pasienten, men ikke skrive journalnotat', async ({ page }) => {
		await logIn(page, 'sekretaer');
		await page.goto('/pasienter');
		await waitOnHydration(page);
		await page.getByRole('link', { name: /Bakken/ }).first().click();
		await expect(page).toHaveURL(/\/pasienter\/[0-9a-fA-F-]{8,}/);
		const id = page.url().split('/pasienter/')[1].split(/[/?]/)[0];

		await page.goto(`/pasienter/${id}/notater`);
		await expect(page.getByRole('heading', { name: 'Nytt notat' })).toHaveCount(0);
	});

	test('systemansvarlig har ingen klinisk tilgang', async ({ page }) => {
		await logIn(page, 'admin');
		await expect(page.getByRole('link', { name: 'Pasienter' })).toHaveCount(0);
		await page.goto('/pasienter');
		await expect(page.locator('body')).toContainText('ikke tilgang til pasientopplysninger');
	});

	test('personvernombudet kommer til sikkerhetsloggen og ser at kjeden er hel', async ({ page }) => {
		await logIn(page, 'ombud');
		await page.goto('/admin/logg');
		await expect(page.getByRole('heading', { name: 'Sikkerhetslogg' })).toBeVisible();
		await expect(page.getByText('Hash-kjeden er ubrutt')).toBeVisible();
	});
});
