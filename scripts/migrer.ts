/** Kjører databasemigrasjonene. Brukes av `npm run migrer` og i CI. */
import { migrer, gjeldendeVersjon } from '../src/lib/server/db/migrate';
import { lukkPool } from '../src/lib/server/db/index';

const kjort = await migrer();
console.log(
	kjort.length > 0
		? `Anvendte migrasjoner: ${kjort.join(', ')}`
		: 'Databasen er allerede oppdatert.'
);
console.log(`Skjemaversjon: ${await gjeldendeVersjon()}`);
await lukkPool();
