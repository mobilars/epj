/** Felles oppsett for testene. Kjøres før hver testfil. */
process.env.EPJ_DATA_KEY ??= 'testnokkel-for-enhetstester-000000000000';
process.env.EPJ_BASE_URL ??= 'http://localhost:5173';
process.env.EPJ_ORG_HER_ID ??= '8000001';
process.env.EPJ_ORG_ORGNR ??= '994598759';
process.env.EPJ_INTEGRATION_MODUS ??= 'mock';

// Alle spørringer er avgrenset til én virksomhet, og `krevTenant()` kaster om
// konteksten mangler. Testene kjører derfor i standardvirksomheten, på samme
// måte som en forespørsel gjør. Isolasjonstestene bytter selv med `medTenant`.
import { beforeAll, beforeEach } from 'vitest';
import { setTenant } from '../src/lib/server/tenant/context';
import { TEST_TENANT } from './fixtures/context';

beforeAll(() => setTenant(TEST_TENANT));
beforeEach(() => setTenant(TEST_TENANT));
