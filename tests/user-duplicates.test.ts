import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, duplicateUserMessage } from '../src/platform/server/auth/users';
import { withTenant, type Tenant } from '../src/platform/server/tenant/context';
import { getTenant } from '../src/platform/server/tenant/tenant';
import { errorForLog } from '../src/platform/server/util/error-log';
import { createTestDatabase, hasTestDatabase, type TestDatabase } from './fixtures/db';

const NATIONAL_ID = '12345678901';

describe('what an error may put in the log', () => {
	it('leaves out the values a database error carries', () => {
		const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
			code: '23505',
			constraint: 'user_account_tenant_national_id_key',
			detail: `Key (tenant_id, national_id)=(standard, ${NATIONAL_ID}) already exists.`
		});
		const line = errorForLog(err);
		expect(line).not.toContain(NATIONAL_ID);
		expect(line).toContain('code=23505');
		expect(line).toContain('constraint=user_account_tenant_national_id_key');
		expect(line).toContain('duplicate key value');
	});

	it('copes with something that is not an error', () => {
		expect(errorForLog({ detail: NATIONAL_ID })).not.toContain(NATIONAL_ID);
	});
});

describe('duplicateUserMessage', () => {
	it('stays out of the way of any other error', () => {
		expect(duplicateUserMessage(new Error('something else'))).toBeNull();
		expect(duplicateUserMessage(Object.assign(new Error('x'), { code: '23505', constraint: 'other' }))).toBeNull();
	});
});

describe.runIf(hasTestDatabase())('creating a user who already exists', () => {
	let db: TestDatabase;
	let tenant: Tenant;

	const attempt = (fields: { username: string; nationalId?: string; email?: string }) =>
		withTenant(tenant, async () => {
			try {
				await createUser({ name: 'Test', password: 'Testpassord1!', roles: ['behandler'], ...fields });
				return null;
			} catch (err) {
				return duplicateUserMessage(err) ?? 'not recognised';
			}
		});

	beforeAll(async () => {
		db = await createTestDatabase('userdup');
		tenant = (await getTenant('standard')) as Tenant;
		expect(await attempt({ username: 'forste', nationalId: '01010112345', email: 'forste@example.com' })).toBeNull();
	});
	afterAll(() => db?.riv());

	it('says so for a fødselsnummer in use', async () => {
		expect(await attempt({ username: 'andre', nationalId: '01010112345' })).toMatch(/Fødselsnummeret er allerede/);
	});

	it('says so for a username in use, whatever the case', async () => {
		expect(await attempt({ username: 'FORSTE' })).toMatch(/Brukernavnet er allerede/);
	});

	it('says so for an email in use', async () => {
		expect(await attempt({ username: 'tredje', email: 'Forste@example.com' })).toMatch(/E-postadressen er allerede/);
	});
});
