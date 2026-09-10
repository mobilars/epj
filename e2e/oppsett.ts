import { execFileSync } from 'node:child_process';

/**
 * Puts demo data into the test database.
 *
 * The database itself has already been created by playwright.config.ts, which
 * must do so before the application starts. Here we wait for the FHIR server to
 * answer, and then run the seeding.
 */
export default async function setup(): Promise<void> {
	await waitOn(`${process.env.EPJ_HAPI_BASE_URL}/metadata`, 60_000);

	execFileSync('npx', ['vite-node', '-c', 'scripts/vite.config.ts', 'scripts/seed.ts'], {
		stdio: 'inherit',
		env: { ...process.env }
	});
}

async function waitOn(url: string, timeoutMs: number): Promise<void> {
	const frist = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
			if (response.ok) return;
		} catch {
			/* trying again */
		}
		if (Date.now() > frist) throw new Error(`Fikk ikke kontakt med ${url}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}
