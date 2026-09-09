/**
 * Sletter og oppretter databasen som ende-til-ende-testene bruker.
 *
 * Kjøres før Playwright starter applikasjonen, slik at appen har en database å
 * migrere inn i ved første forespørsel.
 */
import pg from 'pg';

const url = process.env.EPJ_DATABASE_URL;
if (!url) throw new Error('EPJ_DATABASE_URL må være satt');

const navn = new URL(url).pathname.replace(/^\//, '');
const adminUrl = url.replace(/\/[^/?]*(\?|$)/, '/postgres$1');

const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${navn} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${navn}`);
await admin.end();
console.log(`Testdatabasen ${navn} er nullstilt.`);
