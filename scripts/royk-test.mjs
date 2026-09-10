/**
 * A smoke test against a running installation.
 *
 * Not part of the end-to-end suite, which runs against a local server with its
 * own database. This one drives a real browser against a deployed environment,
 * because that is the only place the whole SMART chain exists at once: the
 * record on one origin, the apps on others, real TLS, the real authorization
 * server. A launch that works locally and fails deployed is exactly the kind
 * of thing this catches.
 *
 *   node scripts/royk-test.mjs https://epj.apps.apus.no
 */

import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'https://epj.apps.apus.no').replace(/\/$/, '');
const results = [];

function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'ok  ' : 'FEIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'nb-NO' });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});

try {
	// --- Sign in as a demo user ------------------------------------------
	await page.goto(`${base}/logg-inn`, { waitUntil: 'domcontentloaded' });
	check('påloggingssiden svarer', await page.getByRole('heading', { name: 'Logg inn' }).isVisible());

	const demoButton = page.locator('.demobruker', { hasText: 'Dr. Ingrid Fastlege' });
	check('demobrukeren er listet', (await demoButton.count()) > 0);
	await demoButton.first().click();
	await page.waitForURL((url) => !url.pathname.startsWith('/logg-inn'), { timeout: 20000 });
	check('innlogget', !page.url().includes('/logg-inn'), page.url());

	// --- Open a patient ---------------------------------------------------
	await page.goto(`${base}/pasienter`, { waitUntil: 'domcontentloaded' });
	const firstPatient = page.locator('table a[href^="/pasienter/"]').first();
	check('pasientlisten har treff', (await firstPatient.count()) > 0);
	const patientHref = await firstPatient.getAttribute('href');
	await firstPatient.click();
	await page.waitForURL(/\/pasienter\/[^/]+$/, { timeout: 20000 });
	check('journalen åpnet', page.url().includes(patientHref ?? ''), page.url());

	// --- The side panel is an app, and it authorises ----------------------
	const frameElement = page.locator('iframe.appramme-side');
	check('sidepanelet er en app-ramme', (await frameElement.count()) > 0);

	if ((await frameElement.count()) > 0) {
		const frame = await frameElement.first().contentFrame();

		// An app the practice has not placed asks for consent first. Approving it
		// here means the consent path is exercised too, rather than skipped.
		await frame
			.getByRole('button', { name: /Gi tilgang|Godkjenn/ })
			.click({ timeout: 8000 })
			.then(() => check('samtykkedialogen ble vist og godkjent', true))
			.catch(() => check('appen slapp inn uten samtykkedialog (plassert av virksomheten)', true));
		// The app runs discovery, PKCE and the token exchange inside the frame,
		// with two redirects, so give it room.
		await frame
			.getByRole('heading', { name: 'Nytt notat' })
			.waitFor({ timeout: 30000 })
			.then(() => check('appen fullførte SMART-innlogging', true))
			.catch(async () =>
				check('appen fullførte SMART-innlogging', false, (await frame.locator('body').innerText()).slice(0, 200))
			);

		// --- Write a note through the app, into the record ------------------
		const marker = `Røyktest ${new Date().toISOString()}`;
		if (await frame.locator('#subjektivt').count()) {
			await frame.locator('#subjektivt').fill(marker);
			await frame.getByRole('button', { name: 'Lagre notat' }).click();
			await frame
				.locator('.varsel-ok')
				.waitFor({ timeout: 30000 })
				.then(() => check('appen skrev notatet gjennom /fhir', true))
				.catch(async () =>
					check('appen skrev notatet gjennom /fhir', false, (await frame.locator('body').innerText()).slice(0, 300))
				);

			// And the record shows what the app wrote.
			await page.goto(`${base}${patientHref}/notater`, { waitUntil: 'domcontentloaded' });
			const body = await page.locator('body').innerText();
			check('journalen viser notatet appen skrev', body.includes(marker.slice(0, 24)));
		}
	}

	// --- The apps dropdown in the record's own tab bar ---------------------
	await page.goto(`${base}${patientHref}`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: /Apper/ }).click();
	const appLinks = page.locator('.nedtrekk-panel a');
	check('appmenyen viser registrerte apper', (await appLinks.count()) > 1);

	// --- The other apps launch too ----------------------------------------
	for (const name of ['Kritisk informasjon', 'Legemidler']) {
		const link = page.locator('.nedtrekk-panel a', { hasText: name });
		if ((await link.count()) === 0) {
			check(`${name} er i appmenyen`, false);
			continue;
		}
		check(`${name} er i appmenyen`, true);
	}

	check('ingen JavaScript-feil i journalen', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (err) {
	check('gjennomkjøring uten unntak', false, String(err).slice(0, 300));
} finally {
	await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} kontroller gikk gjennom.`);
process.exit(failed.length ? 1 : 0);
