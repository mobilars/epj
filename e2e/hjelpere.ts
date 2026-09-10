import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

/** The TOTP code for the demo users. The secret is set by the seed script. */
const DEMO_TOTP = 'JBSWY3DPEHPK3PXP';
const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Buffer {
	let bits = 0, value = 0;
	const out: number[] = [];
	for (const tegn of s.toUpperCase().replace(/=+$/, '')) {
		value = (value << 5) | ALFABET.indexOf(tegn);
		bits += 5;
		if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
	}
	return Buffer.from(out);
}

export function totp(secret = DEMO_TOTP): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
	const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
	return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Waits until the page is hydrated.
 *
 * The UI works without JavaScript, but hydration rewrites input values from the
 * server data. If the test types into a field before that finishes, the text
 * disappears - exactly as it would for a user typing very fast on a slow
 * connection.
 */
export async function waitOnHydration(page: Page): Promise<void> {
	await page.waitForFunction(() => document.documentElement.dataset.hydrert === 'ja');
}

/**
 * The address platform administration is reached on.
 *
 * The organisation is derived from the hostname, so the platform user must sign
 * in on the platform's own hostname - not a practice's. In the test environment
 * both names point at the same server.
 */
export const PLATFORM_URL = `http://localhost:${process.env.E2E_PORT ?? 4173}`;

export async function logIn(page: Page, username: string, password = 'Testpassord1!'): Promise<void> {
	await page.goto('/logg-inn');
	await waitOnHydration(page);
	await page.getByLabel('Brukernavn').fill(username);
	await page.getByLabel('Passord').fill(password);
	await page.getByLabel('Engangskode').fill(totp());
	await page.getByRole('button', { name: 'Logg inn' }).click();
	await expect(page.getByRole('navigation', { name: 'Hovedmeny' })).toBeVisible();
}

/** Signs in as platform administrator, on the platform hostname. */
export async function logInPlatform(page: Page, username = 'systemeier'): Promise<void> {
	await page.goto(`${PLATFORM_URL}/logg-inn`);
	await waitOnHydration(page);
	await page.getByLabel('Brukernavn').fill(username);
	await page.getByLabel('Passord').fill('Testpassord1!');
	await page.getByLabel('Engangskode').fill(totp());
	await page.getByRole('button', { name: 'Logg inn' }).click();
	await expect(page.getByRole('navigation', { name: 'Hovedmeny' })).toBeVisible();
}

export async function logOut(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Logg ut' }).click();
	await expect(page).toHaveURL(/\/logg-inn/);
}

/** Opens the first patient in the list and returns the id from the URL. */
export async function openFirstPatient(page: Page): Promise<string> {
	await page.goto('/pasienter');
	await waitOnHydration(page);
	await page.getByRole('link', { name: /Bakken/ }).first().click();
	await expect(page.getByRole('navigation', { name: 'Journalfaner' })).toBeVisible();
	return page.url().split('/pasienter/')[1].split(/[/?]/)[0];
}
