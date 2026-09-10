/** Runs the database migrations. Used by `npm run migrer` and in CI. */
import { migrate, currentVersion } from '../src/lib/server/db/migrate';
import { closePool } from '../src/lib/server/db/index';
import { ensureDefaultOrganisation } from '../src/lib/server/tenant/tenant';

const kjort = await migrate();
// The default organisation gets its address and organisation details from the
// configuration; SQL cannot read environment variables.
await ensureDefaultOrganisation();
console.log(
	kjort.length > 0
		? `Anvendte migrasjoner: ${kjort.join(', ')}`
		: 'Databasen er allerede oppdatert.'
);
console.log(`Skjemaversjon: ${await currentVersion()}`);
await closePool();
