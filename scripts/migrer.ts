/** Kjører databasemigrasjonene. Brukes av `npm run migrer` og i CI. */
import { migrer, gjeldendeVersjon } from '../src/lib/server/db/migrate';
import { lukkPool } from '../src/lib/server/db/index';
import { sikreStandardvirksomhet } from '../src/lib/server/tenant/tenant';

const kjort = await migrer();
// Standardvirksomheten får adresse og virksomhetsopplysninger fra
// konfigurasjonen; SQL kan ikke lese miljøvariabler.
await sikreStandardvirksomhet();
console.log(
	kjort.length > 0
		? `Anvendte migrasjoner: ${kjort.join(', ')}`
		: 'Databasen er allerede oppdatert.'
);
console.log(`Skjemaversjon: ${await gjeldendeVersjon()}`);
await lukkPool();
