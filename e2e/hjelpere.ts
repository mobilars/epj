import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

/** TOTP-koden for demobrukerne. Hemmeligheten settes av seed-skriptet. */
const DEMO_TOTP = 'JBSWY3DPEHPK3PXP';
const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Dekod(s: string): Buffer {
	let bits = 0, verdi = 0;
	const ut: number[] = [];
	for (const tegn of s.toUpperCase().replace(/=+$/, '')) {
		verdi = (verdi << 5) | ALFABET.indexOf(tegn);
		bits += 5;
		if (bits >= 8) { ut.push((verdi >>> (bits - 8)) & 255); bits -= 8; }
	}
	return Buffer.from(ut);
}

export function totp(hemmelighet = DEMO_TOTP): string {
	const teller = Buffer.alloc(8);
	teller.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
	const hmac = createHmac('sha1', base32Dekod(hemmelighet)).update(teller).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
	return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Venter til siden er hydrert.
 *
 * Grensesnittet virker uten JavaScript, men hydreringen skriver input-verdier
 * på nytt fra serverdataene. Skriver testen inn i et felt før den er ferdig,
 * blir teksten borte - akkurat som den ville gjort for en bruker som taster
 * svært raskt på en treg forbindelse.
 */
export async function ventPaHydrering(page: Page): Promise<void> {
	await page.waitForFunction(() => document.documentElement.dataset.hydrert === 'ja');
}

export async function loggInn(page: Page, brukernavn: string, passord = 'Testpassord1!'): Promise<void> {
	await page.goto('/logg-inn');
	await ventPaHydrering(page);
	await page.getByLabel('Brukernavn').fill(brukernavn);
	await page.getByLabel('Passord').fill(passord);
	await page.getByLabel('Engangskode').fill(totp());
	await page.getByRole('button', { name: 'Logg inn' }).click();
	await expect(page.getByRole('navigation', { name: 'Hovedmeny' })).toBeVisible();
}

export async function loggUt(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Logg ut' }).click();
	await expect(page).toHaveURL(/\/logg-inn/);
}

/** Åpner første pasient i listen og returnerer id-en fra URL-en. */
export async function apneForstePasient(page: Page): Promise<string> {
	await page.goto('/pasienter');
	await ventPaHydrering(page);
	await page.getByRole('link', { name: /Bakken/ }).first().click();
	await expect(page.getByRole('navigation', { name: 'Journalfaner' })).toBeVisible();
	return page.url().split('/pasienter/')[1].split(/[/?]/)[0];
}
