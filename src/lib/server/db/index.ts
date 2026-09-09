import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';

export type Row = Record<string, unknown>;

let instance: DatabaseSync | null = null;
const statementCache = new Map<string, StatementSync>();

function schemaPath(): string {
	// Fungerer både under Vite (kildetre) og i bygget adapter-node-output.
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [
		join(here, 'schema.sql'),
		join(process.cwd(), 'src/lib/server/db/schema.sql')
	]) {
		try {
			readFileSync(candidate);
			return candidate;
		} catch {
			/* prøv neste */
		}
	}
	throw new Error('Finner ikke schema.sql');
}

export function db(): DatabaseSync {
	if (instance) return instance;
	if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });
	instance = new DatabaseSync(config.databasePath);
	instance.exec(readFileSync(schemaPath(), 'utf8'));
	instance.exec("INSERT OR IGNORE INTO schema_version (versjon, anvendt) VALUES (1, datetime('now'))");
	return instance;
}

/** Brukes av testene til å kjøre mot en isolert in-memory-database. */
export function useDatabase(database: DatabaseSync): void {
	instance = database;
	statementCache.clear();
}

export function resetDatabaseForTest(): DatabaseSync {
	const fresh = new DatabaseSync(':memory:');
	fresh.exec(readFileSync(schemaPath(), 'utf8'));
	useDatabase(fresh);
	return fresh;
}

function prepare(sql: string): StatementSync {
	let stmt = statementCache.get(sql);
	if (!stmt) {
		stmt = db().prepare(sql);
		statementCache.set(sql, stmt);
	}
	return stmt;
}

type Param = string | number | bigint | null | Uint8Array;

function normalise(params: unknown[]): Param[] {
	return params.map((p) => {
		if (p === undefined || p === null) return null;
		if (typeof p === 'boolean') return p ? 1 : 0;
		if (typeof p === 'string' || typeof p === 'number' || typeof p === 'bigint') return p;
		if (p instanceof Uint8Array) return p;
		return JSON.stringify(p);
	});
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
	return prepare(sql).all(...normalise(params)) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
	return prepare(sql).get(...normalise(params)) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
	const r = prepare(sql).run(...normalise(params));
	return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/**
 * Kjører `fn` i en transaksjon. Nøstede kall deltar i den ytre transaksjonen
 * (SQLite støtter ikke ekte nøsting uten savepoints, og vi trenger dem ikke her).
 */
let depth = 0;
export function transaction<T>(fn: () => T): T {
	if (depth > 0) return fn();
	const d = db();
	d.exec('BEGIN IMMEDIATE');
	depth++;
	try {
		const result = fn();
		d.exec('COMMIT');
		return result;
	} catch (err) {
		try {
			d.exec('ROLLBACK');
		} catch {
			/* transaksjonen kan allerede være avbrutt */
		}
		throw err;
	} finally {
		depth--;
	}
}
