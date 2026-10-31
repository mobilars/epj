import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, one, query } from '../src/platform/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase } from './fixtures/db';
import { withTenant } from '../src/platform/server/tenant/context';
import { getTenant } from '../src/platform/server/tenant/tenant';
import { getClient, registerClient } from '../src/platform/server/auth/clients';
import { createApp, submitApp, reviewApp, installApp, uninstallApp, getCatalogueApp, publishersForTenant, unapprovedClients, mayBeActivated, installableApps, updateApp } from '../src/platform/server/developer/catalogue';
import type { Tenant } from '../src/platform/server/tenant/context';

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

	it('says who made an installed app, only for the practice that installed it', async () => {
		const app = (await getCatalogueApp(appId))!;
		const { clientId } = await withTenant(a, () => installApp(app, null));

		const seen = await withTenant(a, () => publishersForTenant());
		expect(seen.get(clientId)).toEqual({ publisher: 'Dev', contactEmail: 'dev@example.com' });
		expect((await withTenant(b, () => publishersForTenant())).size).toBe(0);

		await exec("UPDATE developer SET organisation = 'Appmakerne AS' WHERE id = 'dev1'");
		expect((await withTenant(a, () => publishersForTenant())).get(clientId)?.publisher).toBe('Appmakerne AS');
	});

	describe('approval by the platform owner', () => {
		async function submitted(): Promise<string> {
			const id = await createApp('dev1', {
				name: 'Uvurdert', summary: 's', description: 'd', launchUrl: 'https://u.example/launch?c={client_id}',
				redirectUris: ['https://u.example/cb'], scopes: ['launch'], placement: 'ingen',
				contactEmail: '', privacyUrl: '', databehandleravtale: ''
			});
			await submitApp(id, 'dev1');
			return id;
		}

		it('offers an app waiting for review, but not a draft or a refused one', async () => {
			const waiting = await submitted();
			const draft = await createApp('dev1', {
				name: 'Utkast', summary: '', description: '', launchUrl: 'https://d.example/launch',
				redirectUris: ['https://d.example/cb'], scopes: ['launch'], placement: 'ingen',
				contactEmail: '', privacyUrl: '', databehandleravtale: ''
			});
			const refused = await submitted();
			await reviewApp(refused, false, 'nei', null);

			const offered = (await withTenant(a, () => installableApps())).map((app) => app.id);
			expect(offered).toContain(waiting);
			expect(offered).toContain(appId);
			expect(offered).not.toContain(draft);
			expect(offered).not.toContain(refused);
		});

		it('marks an installed app until it is approved, and then what runs is what was approved', async () => {
			const id = await submitted();
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(id))!, null));
			expect(await withTenant(a, () => unapprovedClients())).toContain(clientId);

			await updateApp(id, 'dev1', {
				name: 'Uvurdert', summary: 's', description: 'd', launchUrl: 'https://ny.example/launch?c={client_id}',
				redirectUris: ['https://ny.example/cb'], scopes: ['launch', 'patient/Patient.rs'], placement: 'ingen',
				contactEmail: '', privacyUrl: '', databehandleravtale: ''
			});
			await reviewApp(id, true, 'ok', null);

			expect(await withTenant(a, () => unapprovedClients())).not.toContain(clientId);
			const client = (await withTenant(a, () => getClient(clientId)))!;
			expect(client.redirect_uris).toEqual(['https://ny.example/cb']);
			expect(client.allowed_scopes).toEqual(['launch', 'patient/Patient.rs']);
			expect(client.launch_url).toBe(`https://ny.example/launch?c=${clientId}`);
		});

		it('marks a directly registered app, but not one the platform registered itself', async () => {
			const [direct, own] = await withTenant(a, async () => [
				(await registerClient({ name: 'Direkte', type: 'public', category: 'smart-ehr', redirectUris: ['https://x.example/cb'], scopes: ['launch'] })).client,
				(await registerClient({ name: 'Egen', type: 'public', category: 'smart-ehr', redirectUris: ['https://y.example/cb'], scopes: ['launch'], firstParty: true })).client
			]);
			const unapproved = await withTenant(a, () => unapprovedClients());
			expect(unapproved).toContain(direct.client_id);
			expect(unapproved).not.toContain(own.client_id);
		});

		it('a withdrawn or removed app cannot be switched back on by the practice', async () => {
			const app = (await getCatalogueApp(appId))!;
			const { clientId } = await withTenant(a, () => installApp(app, null));
			expect(await withTenant(a, () => mayBeActivated(clientId))).toBe(true);

			await reviewApp(appId, false, 'trukket', null);
			expect(await withTenant(a, () => mayBeActivated(clientId))).toBe(false);

			await reviewApp(appId, true, 'ok igjen', null);
			expect(await withTenant(a, () => mayBeActivated(clientId))).toBe(true);
			await withTenant(a, () => uninstallApp(appId));
			expect(await withTenant(a, () => mayBeActivated(clientId))).toBe(false);
		});
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
