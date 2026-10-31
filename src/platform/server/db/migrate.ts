import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, one, getPool, query, transaction } from './index';

function platformMigrations(): string {
	const her = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(her, 'migrations'), join(process.cwd(), 'src/platform/server/db/migrations')]) {
		try {
			readdirSync(candidate);
			return candidate;
		} catch {
			/* try the next one */
		}
	}
	throw new Error('Cannot find the migrations directory');
}

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

/** The platform's migrations and each app's. A missing src/apps is an error, not "no migrations". */
function migrationDirectories(): string[] {
	const platform = platformMigrations();
	const apps = join(platform, '..', '..', '..', '..', 'apps');
	const inApps = readdirSync(apps, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(apps, entry.name, 'migrations'))
		.filter((directory) => existsSync(directory));
	return [platform, ...inApps];
}

/**
 * Wherever a migration lives, there is one numbered order for the whole database:
 * an app's tables can refer to the platform's and the other way around, and
 * `schema_migration` records the number alone. A number used twice would make
 * one of the two never run, so it is refused.
 */
export function readMigrasjoner(): Migration[] {
	const migrations = migrationDirectories().flatMap((directory) =>
		readdirSync(directory)
			.filter((f) => f.endsWith('.sql'))
			.map((file) => {
				const m = /^(\d+)_(.+)\.sql$/.exec(file);
				if (!m) throw new Error(`Ugyldig migrasjonsnavn: ${file}`);
				return { version: Number(m[1]), name: m[2], sql: readFileSync(join(directory, file), 'utf8') };
			})
	);
	migrations.sort((a, b) => a.version - b.version);
	for (let i = 1; i < migrations.length; i++) {
		if (migrations[i].version === migrations[i - 1].version) {
			throw new Error(`Two migrations share the number ${migrations[i].version}`);
		}
	}
	return migrations;
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
