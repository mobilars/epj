import pg from 'pg';
import { setPool, closePool, exec } from '../../src/lib/server/db/index';
import { time } from '../../src/lib/server/tenant/context';
import { migrate } from '../../src/lib/server/db/migrate';

/**
 * Creates an isolated PostgreSQL database per test file, runs the migrations,
 * and tears it down afterwards. The tests thus run against real PostgreSQL -
 * not an imitation - so triggers, transactions and types are covered.
 *
 * Requires EPJ_TEST_DATABASE_URL to point at a server where the test user may
 * create databases. Without it the integration tests are skipped.
 */

export const TEST_DB_URL = process.env.EPJ_TEST_DATABASE_URL ?? process.env.EPJ_DATABASE_URL ?? '';

export function hasTestDatabase(): boolean {
	return TEST_DB_URL.length > 0;
}

export interface TestDatabase {
	name: string;
	url: string;
	riv(): Promise<void>;
}

let counter = 0;

export async function createTestDatabase(prefiks = 'epjtest'): Promise<TestDatabase> {
	const name = `${prefiks}_${process.pid}_${++counter}_${Date.now().toString(36)}`.toLowerCase().slice(0, 60);
	const admin = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
	await admin.query(`CREATE DATABASE ${name}`);
	await admin.end();

	const url = TEST_DB_URL.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
	process.env.EPJ_DATABASE_URL = url;
	setPool(new pg.Pool({ connectionString: url, max: 4, options: '-c search_path=epj,public' }));
	await migrate();

	return {
		name,
		url,
		async riv() {
			await closePool();
			const a = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
			await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await a.end();
		}
	};
}

/**
 * `INSERT` for test data, with `tenant_id` filled in automatically.
 *
 * Production code sets the column explicitly everywhere - that discipline is
 * exactly what the isolation rests on. The tests, however, build up state with
 * raw SQL, and should not have to repeat the organisation in every statement.
 */
export async function setIn(sql: string, params: unknown[] = []): Promise<number> {
	const next = params.length + 1;
	const withColumn = sql.replace(/\)\s*VALUES\s*\(/i, ', tenant_id) VALUES (');
	const withValue = withColumn.replace(/\)\s*$/, `, $${next})`);
	if (withValue === sql) throw new Error(`settInn forstod ikke setningen: ${sql}`);
	return exec(withValue, [...params, time()]);
}

/** Empties every table between tests, without running the migrations again. */
export async function emptyTables(): Promise<void> {
	// audit_event has an append-only trigger on DELETE; TRUNCATE goes clear of it.
	await exec(`TRUNCATE TABLE
		audit_event, user_session, oauth_token, oauth_authorization_code, smart_launch,
		oauth_client, break_glass, record_restriction, care_relationship, role_assignment,
		user_account, message, sfm_sync, billing_line, billing_card, settlement,
		copayment_lookup, rate_limit, signing_key RESTART IDENTITY CASCADE`);
}
