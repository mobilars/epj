import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from '../config';

const { Pool } = pg;

/**
 * PostgreSQL-tilgang. Alle spørringer bruker parametriserte uttrykk ($1, $2 ...)
 * - ingen brukerdata settes noen gang inn i SQL som tekst.
 *
 * Transaksjoner spores i AsyncLocalStorage slik at `query()` inne i en
 * `transaction()` automatisk bruker samme klient som transaksjonen.
 */

let pool: pg.Pool | null = null;
const transaksjonsContext = new AsyncLocalStorage<pg.PoolClient>();

// PostgreSQL returnerer BIGINT som streng for å unngå tap av presisjon.
// Beløp lagres i øre og holder seg trygt innenfor Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

export function getPool(): pg.Pool {
	if (!pool) {
		pool = new Pool({
			connectionString: config.databaseUrl,
			max: config.dbPoolMax,
			idleTimeoutMillis: 30_000,
			connectionTimeoutMillis: 10_000,
			application_name: 'epj',
			// Applikasjonstabellene ligger i skjemaet `epj`; HAPI eier `public`.
			options: '-c search_path=epj,public',
			...(config.dbSsl ? { ssl: { rejectUnauthorized: true } } : {})
		});
		pool.on('error', (err) => {
			console.error('[db] uventet feil på inaktiv tilkobling', err);
		});
	}
	return pool;
}

/** Brukes av integrasjonstestene til å injisere en egen pool. */
export function setPool(newValue: pg.Pool | null): void {
	pool = newValue;
}

export async function closePool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
	}
}

function client(): pg.Pool | pg.PoolClient {
	return transaksjonsContext.getStore() ?? getPool();
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	sql: string,
	params: unknown[] = []
): Promise<T[]> {
	const res = await client().query<T>(sql, params as never[]);
	return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
	sql: string,
	params: unknown[] = []
): Promise<T | null> {
	const rows = await query<T>(sql, params);
	return rows[0] ?? null;
}

export async function exec(sql: string, params: unknown[] = []): Promise<number> {
	const res = await client().query(sql, params as never[]);
	return res.rowCount ?? 0;
}

/**
 * Kjører `fn` i en databasetransaksjon. Nøstede kall bruker savepoints, slik at
 * en indre feil kan rulles tilbake uten å avbryte hele den ytre transaksjonen.
 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
	const existing = transaksjonsContext.getStore();
	if (existing) {
		const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
		await existing.query(`SAVEPOINT ${sp}`);
		try {
			const r = await fn();
			await existing.query(`RELEASE SAVEPOINT ${sp}`);
			return r;
		} catch (err) {
			await existing.query(`ROLLBACK TO SAVEPOINT ${sp}`);
			throw err;
		}
	}

	const c = await getPool().connect();
	try {
		await c.query('BEGIN');
		const r = await transaksjonsContext.run(c, fn);
		await c.query('COMMIT');
		return r;
	} catch (err) {
		try {
			await c.query('ROLLBACK');
		} catch {
			/* tilkoblingen kan allerede være borte */
		}
		throw err;
	} finally {
		c.release();
	}
}

/** Rådgivende lås brukt av bakgrunnsjobbene så bare én instans kjører av gangen. */
export async function withLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
	const c = await getPool().connect();
	try {
		const res = await c.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
		if (!res.rows[0]?.locked) return null;
		try {
			return await fn();
		} finally {
			await c.query('SELECT pg_advisory_unlock($1)', [key]);
		}
	} finally {
		c.release();
	}
}
