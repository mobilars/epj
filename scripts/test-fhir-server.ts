/**
 * Starter FHIR-testdobbelen på en fast port.
 *
 * Brukes av Playwright og for lokal utvikling uten Docker. Den ekte
 * HAPI FHIR-serveren startes med `docker compose up hapi`.
 */
import { startTestFhirServer } from '../tests/fixtures/fhir-testserver';
import { createServer } from 'node:http';

const port = Number(process.env.TEST_FHIR_PORT ?? 8080);

const server = await startTestFhirServer();
// startTestFhirServer velger tilfeldig port; vi proxyer den til ønsket port.
const mål = new URL(server.url);

const proxy = createServer((req, res) => {
	const biter: Buffer[] = [];
	req.on('data', (b) => biter.push(b));
	req.on('end', async () => {
		const svar = await fetch(`http://127.0.0.1:${mål.port}${req.url}`, {
			method: req.method,
			headers: req.headers as Record<string, string>,
			body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(biter)
		});
		res.writeHead(svar.status, Object.fromEntries(svar.headers));
		res.end(Buffer.from(await svar.arrayBuffer()));
	});
});

proxy.listen(port, '127.0.0.1', () => {
	console.log(`FHIR-testdobbel kjører på http://127.0.0.1:${port}/fhir`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, async () => {
		proxy.close();
		await server.lukk();
		process.exit(0);
	});
}
