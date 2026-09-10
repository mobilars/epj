import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

/**
 * Ende-til-ende-tester.
 *
 * Kjører mot en fullt oppsatt journal: egen PostgreSQL-database med
 * demodata, en FHIR-server, og applikasjonen bygget som i produksjon.
 * `globalSetup` rigger databasen og seeder den før nettleseren starter.
 */

const APP_PORT = Number(process.env.E2E_PORT ?? 4173);
const FHIR_PORT = Number(process.env.E2E_FHIR_PORT ?? 8099);
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://epj@127.0.0.1:5433/epj_e2e';

const miljo = {
	EPJ_DATABASE_URL: DB_URL,
	EPJ_HAPI_BASE_URL: `http://127.0.0.1:${FHIR_PORT}/fhir`,
	EPJ_BASE_URL: `http://127.0.0.1:${APP_PORT}`,
	EPJ_DATA_KEY: 'e2e-nokkel-kun-for-testkjoring-00000000',
	EPJ_HTTPS_ONLY: 'false',
	EPJ_TESTINNLOGGING: 'true',
	EPJ_VIS_DEMOBRUKERE: 'true',
	EPJ_INTEGRASJON_MODUS: 'mock',
	EPJ_ORG_NAVN: 'Storgata Legesenter',
	EPJ_ORG_HER_ID: '8000001',
	EPJ_ORG_ORGNR: '994598759',
	// Plattformadministrasjonen nås på sitt eget vertsnavn. Testene kjører mot
	// én server, så de to navnene peker på samme adresse: virksomhetene på
	// 127.0.0.1, plattformen på localhost.
	EPJ_PLATTFORM_VERTSNAVN: 'localhost',
	// Testene logger inn på nytt for hver test. Grensene heves slik at
	// ratebegrensningen ikke slår inn - den testes for seg i enhetstestene.
	EPJ_MAX_FAILED_LOGINS: '50',
	EPJ_RATE_AUTH: '2000',
	EPJ_RATE_GENERELL: '20000',
	EPJ_RATE_LOGIN_BRUKER: '2000',
	NODE_ENV: 'test'
};

// Både seed-skriptet i globalSetup og applikasjonen må kjøre med nøyaktig samme
// miljø - særlig EPJ_DATA_KEY, siden TOTP-hemmeligheter krypteres med den.
Object.assign(process.env, miljo);

// Databasen må finnes før Playwright starter applikasjonen; globalSetup kjører
// først etter at webServer er oppe, og er derfor for sent for dette steget.
//
// Konfigurasjonen lastes på nytt i hver arbeidsprosess. Markøren under sørger
// for at nullstillingen bare skjer i hovedprosessen - ellers ville arbeiderne
// slettet dataene globalSetup nettopp la inn.
if (!process.env.E2E_DB_KLAR) {
	execFileSync('npx', ['vite-node', '-c', 'scripts/vite.config.ts', 'scripts/nullstill-e2e-db.ts'], {
		stdio: 'inherit',
		env: { ...process.env, ...miljo }
	});
	process.env.E2E_DB_KLAR = '1';
}

export default defineConfig({
	testDir: 'e2e',
	globalSetup: './e2e/oppsett.ts',
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	timeout: 45_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: `http://127.0.0.1:${APP_PORT}`,
		locale: 'nb-NO',
		timezoneId: 'Europe/Oslo',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// I miljøer der Chromium allerede er installert utenfor Playwright sin
				// egen nedlasting, pekes den ut med PLAYWRIGHT_CHROMIUM_PATH.
				...(process.env.PLAYWRIGHT_CHROMIUM_PATH
					? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
					: {})
			}
		}
	],
	webServer: [
		{
			command: `TEST_FHIR_PORT=${FHIR_PORT} npx vite-node -c scripts/vite.config.ts scripts/test-fhir-server.ts`,
			url: `http://127.0.0.1:${FHIR_PORT}/fhir/metadata`,
			// Databasen nullstilles for hver kjøring, så serverne må starte på nytt
			// og ikke gjenbrukes med tilkoblinger til den gamle databasen.
			// E2E_GJENBRUK=1 er for feilsøking: da kan serverne startes for hånd,
			// slik at loggen deres er synlig mens testene kjører.
			reuseExistingServer: process.env.E2E_GJENBRUK === '1',
			timeout: 60_000,
			env: miljo
		},
		{
			command: `npx vite dev --port ${APP_PORT} --host 127.0.0.1`,
			url: `http://127.0.0.1:${APP_PORT}/logg-inn`,
			reuseExistingServer: process.env.E2E_GJENBRUK === '1',
			timeout: 120_000,
			env: miljo
		}
	]
});
