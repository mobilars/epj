import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, one, getPool, query, transaction } from './index';

function migrasjonskatalog(): string {
	const her = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(her, 'migrations'), join(process.cwd(), 'src/lib/server/db/migrations')]) {
		try {
			readdirSync(candidate);
			return candidate;
		} catch {
			/* prøv neste */
		}
	}
	throw new Error('Finner ikke migrasjonskatalogen');
}

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

export function readMigrasjoner(): Migration[] {
	const directory = migrasjonskatalog();
	return readdirSync(directory)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((file) => {
			const m = /^(\d+)_(.+)\.sql$/.exec(file);
			if (!m) throw new Error(`Ugyldig migrasjonsnavn: ${file}`);
			return { version: Number(m[1]), name: m[2], sql: readFileSync(join(directory, file), 'utf8') };
		});
}

/** Runs every migration not yet applied. Idempotent. */
export async function migrate(): Promise<number[]> {
	const c = await getPool().connect();
	try {
		await c.query('CREATE SCHEMA IF NOT EXISTS epj');
		await c.query(`CREATE TABLE IF NOT EXISTS epj.schema_migration (
			version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
	} finally {
		c.release();
	}

	const anvendte = new Set((await query<{ version: number }>('SELECT version FROM epj.schema_migration')).map((r) => r.version));
	const kjort: number[] = [];
	for (const m of readMigrasjoner()) {
		if (anvendte.has(m.version)) continue;
		await transaction(async () => {
			await exec(m.sql);
			await exec('INSERT INTO epj.schema_migration (version, name) VALUES ($1, $2)', [m.version, m.name]);
		});
		kjort.push(m.version);
	}
	return kjort;
}

export async function currentVersion(): Promise<number> {
	const row = await one<{ v: number | null }>('SELECT MAX(version) AS v FROM epj.schema_migration');
	return row?.v ?? 0;
}
