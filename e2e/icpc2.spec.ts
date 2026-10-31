import { expect, test } from '@playwright/test';
import { logIn, openFirstPatient, waitOnHydration } from './hjelpere';

/** Coding a diagnosis the way it is actually said, in the note form. */
test('finds a code from everyday words, says why, and fills in the official code', async ({ page }) => {
	await logIn(page, 'lege');
	const patientId = await openFirstPatient(page);
	await page.goto(`/pasienter/${patientId}/notater`);
	await waitOnHydration(page);

	const field = page.getByRole('combobox');
	await field.fill('uvi');
	const first = page.getByRole('option').first();
	await expect(first).toContainText('U71');
	await expect(first).toContainText('uvi');

	await field.press('Enter');
	await expect(field).toHaveValue('U71');
	await expect(page.locator('.valgt')).toContainText('Cystitt/urinveisinfeksjon');

	// No Norwegian letters, as on a borrowed keyboard.
	await field.fill('hoyt blodtrykk');
	await expect(page.getByRole('option').first()).toContainText('K86');
});
