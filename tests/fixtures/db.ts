import pg from 'pg';
import { setPool, closePool, exec } from '../../src/lib/server/db/index';
import { time } from '../../src/lib/server/tenant/context';
import { migrate } from '../../src/lib/server/db/migrate';

/**
 * Oppretter en isolert PostgreSQL-database per testfil, kjører migrasjonene,
 * og river den ned etterpå. Testene kjører altså mot ekte PostgreSQL - ikke
 * mot en etterlikning - slik at triggere, transaksjoner og typer blir dekket.
 *
 * Krever at EPJ_TEST_DATABASE_URL peker på en server der testbrukeren kan
 * opprette databaser. Uten den hoppes integrasjonstestene over.
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
 * `INSERT` for testdata, med `tenant_id` fylt ut automatisk.
 *
 * Produksjonskoden setter kolonnen eksplisitt overalt - det er nettopp den
 * disiplinen isolasjonen hviler på. Testene bygger derimot opp tilstand med rå
 * SQL, og skal slippe å gjenta virksomheten i hver eneste setning.
 */
export async function setIn(sql: string, params: unknown[] = []): Promise<number> {
	const next = params.length + 1;
	const withColumn = sql.replace(/\)\s*VALUES\s*\(/i, ', tenant_id) VALUES (');
	const withValue = withColumn.replace(/\)\s*$/, `, $${next})`);
	if (withValue === sql) throw new Error(`settInn forstod ikke setningen: ${sql}`);
	return exec(withValue, [...params, time()]);
}

/** Tømmer alle tabeller mellom tester, uten å kjøre migrasjonene på nytt. */
export async function emptyTables(): Promise<void> {
	// audit_event har en append-only-trigger på DELETE; TRUNCATE går klar av den.
	await exec(`TRUNCATE TABLE
		audit_event, user_session, oauth_token, oauth_authorization_code, smart_launch,
		oauth_client, break_glass, record_restriction, care_relationship, role_assignment,
		user_account, message, sfm_sync, billing_line, billing_card, settlement,
		copayment_lookup, rate_limit, signing_key RESTART IDENTITY CASCADE`);
}
