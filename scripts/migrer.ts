/** Kjører databasemigrasjonene. Brukes av `npm run migrer` og i CI. */
import { migrate, currentVersion } from '../src/lib/server/db/migrate';
import { closePool } from '../src/lib/server/db/index';
import { ensureDefaultOrganisation } from '../src/lib/server/tenant/tenant';

const kjort = await migrate();
// Standardvirksomheten får adresse og virksomhetsopplysninger fra
// konfigurasjonen; SQL kan ikke lese miljøvariabler.
await ensureDefaultOrganisation();
console.log(
	kjort.length > 0
		? `Anvendte migrasjoner: ${kjort.join(', ')}`
		: 'Databasen er allerede oppdatert.'
);
console.log(`Skjemaversjon: ${await currentVersion()}`);
await closePool();
