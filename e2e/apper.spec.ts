import { expect, test } from '@playwright/test';
import { logIn, logInPlatform, PLATFORM_URL, waitOnHydration } from './hjelpere';

/**
 * The life of an app: the platform owner adds it, a practice installs it from the
 * gallery, and removes and deletes it again.
 */
test.describe('platform apps', () => {
	const NAME = 'Plattformapp fra test';

	test('added on the platform, installed by a practice, then removed and deleted', async ({ page }) => {
		await logInPlatform(page);
		await page.goto(`${PLATFORM_URL}/systemadmin/apper`);
		await waitOnHydration(page);
		await page.getByText('Legg til plattformapp').click();
		await page.getByLabel('Navn', { exact: true }).last().fill(NAME);
		await page.getByLabel('Launch-URL').last().fill('https://app.example/launch?c={client_id}');
		await page.getByLabel('Redirect-URI-er').last().fill('https://app.example/callback');
		await page.getByLabel('Scopes').last().fill('openid launch patient/Patient.rs');
		await page.getByLabel('Klientautentisering').last().selectOption('secret');
		await page.getByRole('button', { name: 'Legg til', exact: true }).click();

		// A secret, shown this once.
		const shown = page.getByRole('status').filter({ hasText: 'Klienthemmelighet for' });
		await expect(shown).toContainText(NAME);
		await expect(shown.locator('.mono')).toHaveText(/\S{20,}/);

		await page.goto(`${PLATFORM_URL}/systemadmin/apper`);
		await expect(page.getByText(NAME)).toBeVisible();

		// A practice finds it in the gallery, and it needs no confirmation.
		await logIn(page, 'admin');
		await page.goto('/admin/apper/galleri');
		await waitOnHydration(page);
		const card = page.locator('section.kort').filter({ hasText: NAME });
		await expect(card).toContainText('Plattformapp');
		await expect(card).not.toContainText('ikke godkjent');
		await card.getByRole('button', { name: 'Installer', exact: true }).click();
		await expect(page.getByRole('status').filter({ hasText: 'er installert' })).toBeVisible();

		// Installed, so not the practice's to delete until it has been removed.
		await page.goto('/admin/apper');
		await waitOnHydration(page);
		const row = page.locator('.appkort').filter({ hasText: NAME });
		await expect(row).not.toContainText('ikke godkjent');
		await row.locator('summary').first().click();
		await expect(row).toContainText('Launch-URL');
		await expect(row.getByRole('button', { name: 'Slett appen' })).toHaveCount(0);

		await page.goto('/admin/apper/galleri');
		await waitOnHydration(page);
		await page.locator('section.kort').filter({ hasText: NAME }).getByRole('button', { name: 'Fjern fra virksomheten' }).click();
		await expect(page.locator('section.kort').filter({ hasText: NAME }).getByRole('button', { name: 'Installer', exact: true })).toBeVisible();

		await page.goto('/admin/apper');
		await waitOnHydration(page);
		const removed = page.locator('.appkort').filter({ hasText: NAME });
		await removed.locator('summary').first().click();
		page.once('dialog', (dialog) => dialog.accept());
		await removed.getByRole('button', { name: 'Slett appen' }).click();
		await expect(page.locator('.appkort').filter({ hasText: NAME })).toHaveCount(0);
	});

	test('an installed app is not offered for deletion, and the form to register one is gone', async ({ page }) => {
		await logIn(page, 'admin');
		await page.goto('/admin/apper');
		await expect(page.locator('form[action="?/register"]')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Legg til fra appgalleriet' })).toBeVisible();
		const seeded = page.locator('.appkort').filter({ hasText: 'Diabetesoversikt (demo)' });
		await expect(seeded).not.toContainText('ikke godkjent');
		await expect(seeded.getByRole('button', { name: 'Slett appen' })).toHaveCount(0);
	});
});
