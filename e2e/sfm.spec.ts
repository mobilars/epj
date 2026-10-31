import { expect, test } from '@playwright/test';
import { logIn, openFirstPatient, waitOnHydration } from './hjelpere';

/**
 * SFM's screen in the Legemidler tab, against the local simulator.
 *
 * Run on its own, because it turns on what the other tests expect to be off:
 *
 *   EPJ_SFM_FULL=true npx playwright test e2e/sfm.spec.ts
 */
test.describe('SFM Full against the simulator', () => {
	test.skip(process.env.EPJ_SFM_FULL !== 'true', 'needs EPJ_SFM_FULL=true');

	test('opens the patient in the frame, with no patient identity in the conversation', async ({ page }) => {
		const posted: string[] = [];
		page.on('response', async (response) => {
			if (response.url().includes('sfm-sesjon')) posted.push(await response.text());
		});

		await logIn(page, 'lege');
		const patientId = await openFirstPatient(page);
		await page.goto(`/pasienter/${patientId}/legemidler`);
		await waitOnHydration(page);

		const frame = page.frameLocator('iframe.sfm');
		await expect(frame.getByText('Pasient åpnet med billett.')).toBeVisible();
		await expect(page.locator('iframe.sfm')).toHaveAttribute('data-state', 'ready');

		// The banner outside the frame says whose record this is; the frame does not.
		await expect(page.locator('.pasientbanner')).toBeVisible();
		expect(posted).toHaveLength(1);
		expect(posted[0]).not.toMatch(/\d{11}/);
		// The record's own prescribing form is gone: prescribing happens in SFM.
		await expect(page.getByRole('button', { name: /Forskriv/ })).toHaveCount(0);
	});

	test('marks the frame as external, says it is a simulator, and the marking can be turned off', async ({ page }) => {
		await logIn(page, 'lege');
		const patientId = await openFirstPatient(page);
		const legemidler = `/pasienter/${patientId}/legemidler`;

		await page.goto(legemidler);
		await waitOnHydration(page);
		const stripe = page.locator('.ekstern-stripe');
		await expect(stripe).toContainText('SFM-simulator');
		await expect(stripe).toContainText('ikke koblet til Norsk helsenett');

		await page.goto('/innstillinger');
		await waitOnHydration(page);
		await page.getByLabel('Merk eksterne apper').uncheck();
		await page.locator('form[action="?/externalApps"] button').click();
		await expect(page.getByLabel('Merk eksterne apper')).not.toBeChecked();

		await page.goto(legemidler);
		await waitOnHydration(page);
		await expect(page.locator('iframe.sfm')).toBeVisible();
		await expect(page.locator('.ekstern-stripe')).toHaveCount(0);

		// Back on, so the next test finds it as a new user would.
		await page.goto('/innstillinger');
		await waitOnHydration(page);
		await page.getByLabel('Merk eksterne apper').check();
		await page.locator('form[action="?/externalApps"] button').click();
		await expect(page.getByLabel('Merk eksterne apper')).toBeChecked();
	});
});
