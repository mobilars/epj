import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, one, query } from '../src/platform/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase } from './fixtures/db';
import { withTenant } from '../src/platform/server/tenant/context';
import { getTenant } from '../src/platform/server/tenant/tenant';
import { authenticateClient, deleteClient, getClient, registerClient } from '../src/platform/server/auth/clients';
import { createApp, submitApp, reviewApp, installApp, uninstallApp, getCatalogueApp, publishersForTenant, unapprovedClients, mayBeActivated, mayBeDeleted, installableApps, updateApp, savePlatformApp, platformApps, newAppSecret, firstAppSecret } from '../src/platform/server/developer/catalogue';
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

	const input = (name: string, extra: object = {}) => ({
		name, summary: 's', description: 'd', launchUrl: 'https://p.example/launch?c={client_id}',
		redirectUris: ['https://p.example/cb'], scopes: ['launch', 'patient/Patient.rs'], placement: 'ingen' as const,
		contactEmail: '', privacyUrl: '', databehandleravtale: '', ...extra
	});

	describe('platform apps', () => {
		it('are approved as they stand, offered in the gallery, and say who made them', async () => {
			const { id } = await savePlatformApp(null, input('Plattformapp'), null);
			const app = (await getCatalogueApp(id))!;
			expect(app.status).toBe('godkjent');
			expect(app.is_platform_app).toBe(true);
			expect((await withTenant(a, () => installableApps())).map((x) => x.id)).toContain(id);

			const { clientId } = await withTenant(a, () => installApp(app, null));
			const publisher = (await withTenant(a, () => publishersForTenant())).get(clientId);
			expect(publisher?.publisher).toBe('APUS Roland AS');
		});

		it('reach every practice at once when changed', async () => {
			const { id } = await savePlatformApp(null, input('Gammelt navn'), null);
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(id))!, null));
			await savePlatformApp(id, input('Nytt navn', { launchUrl: 'https://p.example/ny?c={client_id}' }), null);
			const client = (await withTenant(a, () => getClient(clientId)))!;
			expect(client.name).toBe('Nytt navn');
			expect(client.launch_url).toBe(`https://p.example/ny?c=${clientId}`);
			expect((await platformApps()).map((x) => x.name)).toEqual(['Nytt navn']);
		});

		it('take over a tab and skip the dialog, where a developer app does not', async () => {
			const { id } = await savePlatformApp(null, input('Notater', { placement: 'side', replacesTab: 'notater' }), null);
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(id))!, null));
			const client = (await withTenant(a, () => getClient(clientId)))!;
			expect(client.replaces_tab).toBe('notater');
			expect(client.require_consent).toBe(false);
		});
	});

	describe('how an app proves who it is', () => {
		const tokenRequest = (clientId: string, secret?: string) =>
			authenticateClient(new URLSearchParams({ client_id: clientId, ...(secret ? { client_secret: secret } : {}) }), null);

		async function withSecret(): Promise<{ id: string; secret: string }> {
			const id = await createApp('dev1', input('Med hemmelighet', { clientType: 'secret' }));
			const secret = (await firstAppSecret(id, 'dev1'))!;
			await submitApp(id, 'dev1');
			await reviewApp(id, true, 'ok', null);
			return { id, secret };
		}

		it("an installed app signs in with its developer's secret, in any practice", async () => {
			const { id, secret } = await withSecret();
			const app = (await getCatalogueApp(id))!;
			const inA = await withTenant(a, () => installApp(app, null));
			const inB = await withTenant(b, () => installApp(app, null));
			expect(inA.clientId).not.toBe(inB.clientId);

			for (const [tenant, clientId] of [[a, inA.clientId], [b, inB.clientId]] as const) {
				expect((await withTenant(tenant, () => tokenRequest(clientId, secret))).ok).toBe(true);
				expect((await withTenant(tenant, () => tokenRequest(clientId, 'feil'))).ok).toBe(false);
				expect((await withTenant(tenant, () => tokenRequest(clientId))).ok).toBe(false);
			}
		});

		it('gives no secret twice, and a new one replaces the old at once', async () => {
			const { id, secret } = await withSecret();
			expect(await firstAppSecret(id, 'dev1')).toBeNull();
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(id))!, null));

			const replaced = (await newAppSecret(id, 'dev1'))!;
			expect((await withTenant(a, () => tokenRequest(clientId, secret))).ok).toBe(false);
			expect((await withTenant(a, () => tokenRequest(clientId, replaced))).ok).toBe(true);
		});

		it("only the app's own developer can replace its secret", async () => {
			const { id } = await withSecret();
			await exec("INSERT INTO developer (id, email, name) VALUES ('dev2', 'dev2@example.com', 'Dev2')");
			expect(await newAppSecret(id, 'dev2')).toBeNull();
		});

		it('a move to a secret reaches an installed app when approved, not before', async () => {
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(appId))!, null));
			const edited = input('Testapp', { clientType: 'secret' });
			await updateApp(appId, 'dev1', edited);
			const secret = (await firstAppSecret(appId, 'dev1'))!;
			expect((await withTenant(a, () => getClient(clientId)))!.type).toBe('public');

			await reviewApp(appId, true, 'ok', null);
			expect((await withTenant(a, () => getClient(clientId)))!.type).toBe('confidential');
			expect((await withTenant(a, () => tokenRequest(clientId, secret))).ok).toBe(true);
		});
	});

	describe('deleting from a practice', () => {
		it('removes an app the practice added, and its tokens, and leaves others alone', async () => {
			const { client } = await withTenant(a, () =>
				registerClient({ name: 'Egen', type: 'public', category: 'smart-ehr', redirectUris: ['https://x.example/cb'], scopes: ['launch'] })
			);
			const token = await tokenFor(a, client.client_id);
			expect(await withTenant(a, () => mayBeDeleted(client.client_id))).toBe(true);
			await withTenant(a, () => deleteClient(client.client_id));
			expect(await withTenant(a, () => getClient(client.client_id))).toBeNull();
			expect(await query('SELECT id FROM oauth_token WHERE id = $1', [token])).toHaveLength(0);
		});

		it('not an installed app, until it has been removed through the gallery', async () => {
			const app = (await getCatalogueApp(appId))!;
			const { clientId } = await withTenant(a, () => installApp(app, null));
			expect(await withTenant(a, () => mayBeDeleted(clientId))).toBe(false);
			await withTenant(a, () => uninstallApp(appId));
			expect(await withTenant(a, () => mayBeDeleted(clientId))).toBe(true);
		});

		it('cannot reach another practice', async () => {
			const { client } = await withTenant(a, () =>
				registerClient({ name: 'Egen', type: 'public', category: 'smart-ehr', redirectUris: ['https://x.example/cb'], scopes: ['launch'] })
			);
			await withTenant(b, () => deleteClient(client.client_id));
			expect(await withTenant(a, () => getClient(client.client_id))).toBeTruthy();
		});
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
				name: 'Nytt navn', summary: 's', description: 'd', launchUrl: 'https://ny.example/launch?c={client_id}',
				redirectUris: ['https://ny.example/cb'], scopes: ['launch', 'patient/Patient.rs'], placement: 'ingen',
				contactEmail: '', privacyUrl: '', databehandleravtale: ''
			});
			await reviewApp(id, true, 'ok', null);

			expect(await withTenant(a, () => unapprovedClients())).not.toContain(clientId);
			const client = (await withTenant(a, () => getClient(clientId)))!;
			expect(client.name).toBe('Nytt navn');
			expect(client.redirect_uris).toEqual(['https://ny.example/cb']);
			expect(client.allowed_scopes).toEqual(['launch', 'patient/Patient.rs']);
			expect(client.launch_url).toBe(`https://ny.example/launch?c=${clientId}`);
		});

		it('an edit to an approved app reaches the practice when approved, and is not marked meanwhile', async () => {
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(appId))!, null));
			await updateApp(appId, 'dev1', {
				name: 'Endret', summary: 's', description: 'd', launchUrl: 'https://app.example/launch/smart',
				redirectUris: ['https://app.example/cb'], scopes: ['launch', 'patient/Patient.rs'], placement: 'side',
				contactEmail: 'dev@example.com', privacyUrl: '', databehandleravtale: ''
			});

			// Still running the copy that was approved, so nothing to warn about.
			expect((await getCatalogueApp(appId))!.status).toBe('til-vurdering');
			expect(await withTenant(a, () => unapprovedClients())).not.toContain(clientId);
			const before = (await withTenant(a, () => getClient(clientId)))!;
			expect(before.name).toBe('Testapp');
			expect(before.launch_url).toBe('https://app.example/launch');

			await reviewApp(appId, true, 'ok', null);
			const after = (await withTenant(a, () => getClient(clientId)))!;
			expect(after.name).toBe('Endret');
			expect(after.launch_url).toBe('https://app.example/launch/smart');
		});

		it('marks a directly registered app, but not a platform app', async () => {
			const direct = await withTenant(a, async () =>
				(await registerClient({ name: 'Direkte', type: 'public', category: 'smart-ehr', redirectUris: ['https://x.example/cb'], scopes: ['launch'] })).client
			);
			const own = await savePlatformApp(null, input('Egen'), null);
			const { clientId } = await withTenant(a, async () => installApp((await getCatalogueApp(own.id))!, null));
			const unapproved = await withTenant(a, () => unapprovedClients());
			expect(unapproved).toContain(direct.client_id);
			expect(unapproved).not.toContain(clientId);
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
