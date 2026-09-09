import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, en, getPool, query, transaction } from './index';

function migrasjonskatalog(): string {
	const her = dirname(fileURLToPath(import.meta.url));
	for (const kandidat of [join(her, 'migrations'), join(process.cwd(), 'src/lib/server/db/migrations')]) {
		try {
			readdirSync(kandidat);
			return kandidat;
		} catch {
			/* prøv neste */
		}
	}
	throw new Error('Finner ikke migrasjonskatalogen');
}

export interface Migrasjon {
	versjon: number;
	navn: string;
	sql: string;
}

export function lesMigrasjoner(): Migrasjon[] {
	const katalog = migrasjonskatalog();
	return readdirSync(katalog)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((fil) => {
			const m = /^(\d+)_(.+)\.sql$/.exec(fil);
			if (!m) throw new Error(`Ugyldig migrasjonsnavn: ${fil}`);
			return { versjon: Number(m[1]), navn: m[2], sql: readFileSync(join(katalog, fil), 'utf8') };
		});
}

/** Kjører alle migrasjoner som ikke er anvendt. Idempotent. */
export async function migrer(): Promise<number[]> {
	const c = await getPool().connect();
	try {
		await c.query('CREATE SCHEMA IF NOT EXISTS epj');
		await c.query(`CREATE TABLE IF NOT EXISTS epj.schema_migration (
			versjon INTEGER PRIMARY KEY, navn TEXT NOT NULL, anvendt TIMESTAMPTZ NOT NULL DEFAULT now())`);
	} finally {
		c.release();
	}

	const anvendte = new Set((await query<{ versjon: number }>('SELECT versjon FROM epj.schema_migration')).map((r) => r.versjon));
	const kjort: number[] = [];
	for (const m of lesMigrasjoner()) {
		if (anvendte.has(m.versjon)) continue;
		await transaction(async () => {
			await exec(m.sql);
			await exec('INSERT INTO epj.schema_migration (versjon, navn) VALUES ($1, $2)', [m.versjon, m.navn]);
		});
		kjort.push(m.versjon);
	}
	return kjort;
}

export async function gjeldendeVersjon(): Promise<number> {
	const rad = await en<{ v: number | null }>('SELECT MAX(versjon) AS v FROM epj.schema_migration');
	return rad?.v ?? 0;
}
