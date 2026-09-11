import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, one, query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase } from './fixtures/db';
import { withTenant } from '../src/lib/server/tenant/context';
import { getTenant } from '../src/lib/server/tenant/tenant';
import { getClient } from '../src/lib/server/auth/clients';
import { createApp, submitApp, reviewApp, installApp, uninstallApp, getCatalogueApp } from '../src/lib/server/developer/catalogue';
import type { Tenant } from '../src/lib/server/tenant/context';

const describeIf = hasTestDatabase() ? describe : describe.skip;

/**
 * The catalogue's exits.
 *
 * Getting an app in is the easy direction. What has to be right is getting it
 * out: a practice that uninstalls must know the app is gone, and the platform
 * withdrawing an approval must stop the app at every practice that took it -
 * without anyone at those practices having to do anything.
 */
describeIf('catalogue', () => {
	let db: TestDatabase;
	let a: Tenant;
	let b: Tenant;
	let appId: string;

	beforeAll(async () => {
		db = await createTestDatabase('catalogue');
	});

	afterAll(async () => {
		await db.riv();
	});

	beforeEach(async () => {
		await emptyTables();
		await exec('DELETE FROM catalogue_install');
		await exec('DELETE FROM catalogue_app');
		await exec('DELETE FROM developer');
		await exec("DELETE FROM tenant WHERE id NOT IN ('standard', 'plattform')");
		a = (await getTenant('standard')) as Tenant;
		// Inserted directly: creating through the module would provision a FHIR
		// partition, and nothing here touches clinical data.
		await exec(
			`INSERT INTO tenant (id, name, organisation_number, hostname, base_url, partition_id)
			 VALUES ('legekontor-b', 'Legekontor B', '994598759', 'b.epj.test', 'https://b.epj.test', 99)`
		);
		b = (await getTenant('legekontor-b')) as Tenant;

		await exec("INSERT INTO developer (id, email, name) VALUES ('dev1', 'dev@example.com', 'Dev')");
		appId = await createApp('dev1', {
			name: 'Testapp', summary: 's', description: 'd', launchUrl: 'https://app.example/launch',
			redirectUris: ['https://app.example/cb'], scopes: ['launch', 'patient/Patient.rs'], placement: 'side',
			contactEmail: 'dev@example.com', privacyUrl: 'https://app.example/privacy', databehandleravtale: 'DBA-1'
		});
		await submitApp(appId, 'dev1');
		await reviewApp(appId, true, 'ok', null);
	});

	async function tokenFor(tenant: Tenant, clientId: string): Promise<string> {
		const id = `tok-${tenant.id}-${clientId}`;
		await exec(
			`INSERT INTO oauth_token (id, tenant_id, client_id, kind, token_hash, scope, launch_context, familie, expires_at)
			 VALUES ($1, $2, $3, 'access', $1, 'patient/Patient.rs', '{}', $1, now() + interval '1 hour')`,
			[id, tenant.id, clientId]
		);
		return id;
	}

	it('installs the same app as separate clients in each practice', async () => {
		const app = (await getCatalogueApp(appId))!;
		const ia = await withTenant(a, () => installApp(app, null));
		const ib = await withTenant(b, () => installApp(app, null));
		expect(ia.clientId).not.toBe(ib.clientId);
		expect(await withTenant(a, () => getClient(ia.clientId))).toBeTruthy();
		expect(await withTenant(a, () => getClient(ib.clientId))).toBeNull();
	});

	it('uninstalling blocks the client and revokes its tokens', async () => {
		const app = (await getCatalogueApp(appId))!;
		const { clientId } = await withTenant(a, () => installApp(app, null));
		const tok = await tokenFor(a, clientId);

		await withTenant(a, () => uninstallApp(appId));

		const client = await withTenant(a, () => getClient(clientId));
		expect(client?.status).toBe('sperret');
		const row = await one<{ revoked: boolean }>('SELECT revoked FROM oauth_token WHERE id = $1', [tok]);
		expect(row?.revoked).toBe(true);
		expect(await query('SELECT 1 FROM catalogue_install WHERE catalogue_id = $1', [appId])).toHaveLength(0);
	});

	it('withdrawing the approval blocks every installation, across practices', async () => {
		const app = (await getCatalogueApp(appId))!;
		const ia = await withTenant(a, () => installApp(app, null));
		const ib = await withTenant(b, () => installApp(app, null));
		const ta = await tokenFor(a, ia.clientId);
		const tb = await tokenFor(b, ib.clientId);

		await reviewApp(appId, false, 'Sender data ut av landet', null);

		expect((await getCatalogueApp(appId))?.status).toBe('avvist');
		expect((await withTenant(a, () => getClient(ia.clientId)))?.status).toBe('sperret');
		expect((await withTenant(b, () => getClient(ib.clientId)))?.status).toBe('sperret');
		for (const t of [ta, tb]) {
			const row = await one<{ revoked: boolean; revoked_reason: string }>('SELECT revoked, revoked_reason FROM oauth_token WHERE id = $1', [t]);
			expect(row?.revoked).toBe(true);
			expect(row?.revoked_reason).toContain('plattformen');
		}
		// The install rows stay so the practice can see what happened.
		expect(await query('SELECT 1 FROM catalogue_install WHERE catalogue_id = $1', [appId])).toHaveLength(2);
	});
});
