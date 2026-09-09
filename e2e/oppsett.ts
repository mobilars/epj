import { execFileSync } from 'node:child_process';

/**
 * Legger demodata inn i testdatabasen.
 *
 * Selve databasen er allerede opprettet av playwright.config.ts, som må gjøre
 * det før applikasjonen starter. Her venter vi på at FHIR-serveren svarer, og
 * kjører deretter seedingen.
 */
export default async function oppsett(): Promise<void> {
	await ventPa(`${process.env.EPJ_HAPI_BASE_URL}/metadata`, 60_000);

	execFileSync('npx', ['vite-node', '-c', 'scripts/vite.config.ts', 'scripts/seed.ts'], {
		stdio: 'inherit',
		env: { ...process.env }
	});
}

async function ventPa(url: string, timeoutMs: number): Promise<void> {
	const frist = Date.now() + timeoutMs;
	for (;;) {
		try {
			const svar = await fetch(url, { signal: AbortSignal.timeout(3000) });
			if (svar.ok) return;
		} catch {
			/* prøver igjen */
		}
		if (Date.now() > frist) throw new Error(`Fikk ikke kontakt med ${url}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}
