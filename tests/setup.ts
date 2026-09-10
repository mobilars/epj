/** Felles oppsett for testene. Kjøres før hver testfil. */
process.env.EPJ_DATA_KEY ??= 'testnokkel-for-enhetstester-000000000000';
process.env.EPJ_BASE_URL ??= 'http://localhost:5173';
process.env.EPJ_ORG_HER_ID ??= '8000001';
process.env.EPJ_ORG_ORGNR ??= '994598759';
process.env.EPJ_INTEGRASJON_MODUS ??= 'mock';

// Alle spørringer er avgrenset til én virksomhet, og `krevTenant()` kaster om
// konteksten mangler. Testene kjører derfor i standardvirksomheten, på samme
// måte som en forespørsel gjør. Isolasjonstestene bytter selv med `medTenant`.
import { beforeAll, beforeEach } from 'vitest';
import { settTenant } from '../src/lib/server/tenant/kontekst';
import { TEST_TENANT } from './fixtures/kontekst';

beforeAll(() => settTenant(TEST_TENANT));
beforeEach(() => settTenant(TEST_TENANT));
