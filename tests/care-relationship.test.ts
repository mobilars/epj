import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasCareRelationship } from '../src/platform/server/authz/access';
import { createUser } from '../src/platform/server/auth/users';
import { query } from '../src/platform/server/db';
import { registerAsCarer } from '../src/platform/server/journal/care-relationship';
import { withTenant, type Tenant } from '../src/platform/server/tenant/context';
import { getTenant } from '../src/platform/server/tenant/tenant';
import { createTestDatabase, hasTestDatabase, type TestDatabase } from './fixtures/db';

describe.runIf(hasTestDatabase())('registering as carer of a patient', () => {
	let db: TestDatabase;
	let tenant: Tenant;
	let first: string;
	let second: string;

	beforeAll(async () => {
		db = await createTestDatabase('carerel');
		tenant = (await getTenant('standard')) as Tenant;
		[first, second] = await withTenant(tenant, async () => [
			(await createUser({ username: 'forste', name: 'Første', password: 'Testpassord1!', roles: ['behandler'] })).id,
			(await createUser({ username: 'andre', name: 'Andre', password: 'Testpassord1!', roles: ['behandler'] })).id
		]);
	});
	afterAll(() => db?.riv());

	it('gives this user the relationship, and only this patient', async () => {
		await withTenant(tenant, async () => {
			expect(await hasCareRelationship(first, 'p1')).toBe(false);
			await registerAsCarer(first, 'p1');
			expect(await hasCareRelationship(first, 'p1')).toBe(true);
			expect(await hasCareRelationship(first, 'p2')).toBe(false);
			expect(await hasCareRelationship(second, 'p1')).toBe(false);
		});
	});

	it('records that the clinician did it themselves', async () => {
		const [row] = await query<{ basis: string; created_by: string }>(
			"SELECT basis, created_by FROM care_relationship WHERE user_id = $1 AND patient_id = 'p1'",
			[first]
		);
		expect(row).toEqual({ basis: 'selvregistrert', created_by: first });
	});

	it('leaves one relationship when pressed twice', async () => {
		await withTenant(tenant, () => registerAsCarer(first, 'p1'));
		const rows = await query("SELECT id FROM care_relationship WHERE user_id = $1 AND patient_id = 'p1'", [first]);
		expect(rows).toHaveLength(1);
	});
});
