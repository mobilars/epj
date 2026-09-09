import pg from 'pg';
import { setPool, lukkPool, exec } from '../../src/lib/server/db/index';
import { migrer } from '../../src/lib/server/db/migrate';

/**
 * Oppretter en isolert PostgreSQL-database per testfil, kjører migrasjonene,
 * og river den ned etterpå. Testene kjører altså mot ekte PostgreSQL - ikke
 * mot en etterlikning - slik at triggere, transaksjoner og typer blir dekket.
 *
 * Krever at EPJ_TEST_DATABASE_URL peker på en server der testbrukeren kan
 * opprette databaser. Uten den hoppes integrasjonstestene over.
 */

export const TEST_DB_URL = process.env.EPJ_TEST_DATABASE_URL ?? process.env.EPJ_DATABASE_URL ?? '';

export function harTestdatabase(): boolean {
	return TEST_DB_URL.length > 0;
}

export interface Testdatabase {
	navn: string;
	url: string;
	riv(): Promise<void>;
}

let teller = 0;

export async function opprettTestdatabase(prefiks = 'epjtest'): Promise<Testdatabase> {
	const navn = `${prefiks}_${process.pid}_${++teller}_${Date.now().toString(36)}`.toLowerCase().slice(0, 60);
	const admin = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
	await admin.query(`CREATE DATABASE ${navn}`);
	await admin.end();

	const url = TEST_DB_URL.replace(/\/[^/?]*(\?|$)/, `/${navn}$1`);
	process.env.EPJ_DATABASE_URL = url;
	setPool(new pg.Pool({ connectionString: url, max: 4, options: '-c search_path=epj,public' }));
	await migrer();

	return {
		navn,
		url,
		async riv() {
			await lukkPool();
			const a = new pg.Pool({ connectionString: TEST_DB_URL, max: 1 });
			await a.query(`DROP DATABASE IF EXISTS ${navn} WITH (FORCE)`);
			await a.end();
		}
	};
}

/** Tømmer alle tabeller mellom tester, uten å kjøre migrasjonene på nytt. */
export async function tomTabeller(): Promise<void> {
	// audit_event har en append-only-trigger på DELETE; TRUNCATE går klar av den.
	await exec(`TRUNCATE TABLE
		audit_event, user_session, oauth_token, oauth_authorization_code, smart_launch,
		oauth_client, break_glass, journal_sperring, care_relationship, role_assignment,
		user_account, melding, sfm_synk, regningslinje, regningskort, oppgjor,
		egenandel_oppslag, rate_limit, signing_key RESTART IDENTITY CASCADE`);
}
