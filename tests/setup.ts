/** Common setup for the tests. Runs before every test file. */
process.env.EPJ_DATA_KEY ??= 'testnokkel-for-enhetstester-000000000000';
process.env.EPJ_BASE_URL ??= 'http://localhost:5173';
process.env.EPJ_ORG_HER_ID ??= '8000001';
process.env.EPJ_ORG_NUMBER ??= '994598759';
process.env.EPJ_INTEGRATION_MODE ??= 'mock';

// Every query is bounded to one organisation, and `krevTenant()` throws if the
// context is missing. The tests therefore run in the default organisation, the
// same way a request does. The isolation tests switch themselves with `medTenant`.
import { beforeAll, beforeEach } from 'vitest';
import { setTenant } from '../src/lib/server/tenant/context';
import { TEST_TENANT } from './fixtures/context';

beforeAll(() => setTenant(TEST_TENANT));
beforeEach(() => setTenant(TEST_TENANT));
