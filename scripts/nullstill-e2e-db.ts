/**
 * Drops and creates the database the end-to-end tests use.
 *
 * Runs before Playwright starts the application, so the app has a database to
 * migrate into on its first request.
 */
import pg from 'pg';

const url = process.env.EPJ_DATABASE_URL;
if (!url) throw new Error('EPJ_DATABASE_URL må være satt');

const name = new URL(url).pathname.replace(/^\//, '');
const adminUrl = url.replace(/\/[^/?]*(\?|$)/, '/postgres$1');

const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();
console.log(`Testdatabasen ${name} er nullstilt.`);
