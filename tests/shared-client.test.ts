import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, one } from '../src/platform/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase } from './fixtures/db';
import { withTenant, type Tenant } from '../src/platform/server/tenant/context';
import { getTenant } from '../src/platform/server/tenant/tenant';
import { authenticateClient, getClient, setKlientstatus } from '../src/platform/server/auth/clients';
import { createApp, firstAppSecret, getCatalogueApp, installApp, reviewApp, submitApp, uninstallApp } from '../src/platform/server/developer/catalogue';
import { createAuthorisationCode, exchangeInCode } from '../src/platform/server/auth/oauth';
import { pkceChallenge, renewWithRefreshToken, validateAccessToken } from '../src/platform/server/auth/tokens';
import { tenantIdForCredential } from '../src/platform/server/auth/credential-tenant';
import { emptyKeyCache, publishedJwks } from '../src/platform/server/auth/keys';
import { decodeWithoutVerification } from '../src/platform/server/auth/jws';

const describeIf = hasTestDatabase() ? describe : describe.skip;

/**
 * One app, one client id and one secret, for every customer, on one address.
 *
 * This is how an app written for WebMed expects a record system to behave: it holds a
 * single registration, and the token says which customer a launch came from.
 */
describeIf('an app shared by every practice', () => {
	let db: TestDatabase;
	let a: Tenant;
	let b: Tenant;
	let clientId = '';
	let secret = '';
	const verifier = 'v'.repeat(50);
	const redirectUri = 'https://app.example/cb';

	beforeAll(async () => {
		db = await createTestDatabase('sharedclient');
	});

	afterAll(async () => {
		await db.riv();
	});

	beforeEach(async () => {
		await emptyTables();
		emptyKeyCache();
		await exec('DELETE FROM catalogue_install');
		await exec('DELETE FROM catalogue_app');
		await exec('DELETE FROM developer');
		await exec("DELETE FROM tenant WHERE id NOT IN ('standard', 'plattform')");
		await exec("UPDATE tenant SET base_url = 'https://felles.epj.test', hostname = NULL WHERE id = 'standard'");
		await exec(
			`INSERT INTO tenant (id, name, organisation_number, base_url, partition_id)
			 VALUES ('legekontor-b', 'Legekontor B', '994598759', 'https://felles.epj.test', 99)`
		);
		a = (await getTenant('standard')) as Tenant;
		b = (await getTenant('legekontor-b')) as Tenant;
		for (const tenant of [a, b]) {
			await exec('INSERT INTO user_account (id, tenant_id, username, name) VALUES ($1,$2,$3,$4)', [`u-${tenant.id}`, tenant.id, 'lege', 'Lege']);
		}

		await exec("INSERT INTO developer (id, email, name) VALUES ('dev1', 'dev@example.com', 'Dev')");
		const id = await createApp('dev1', {
			name: 'Felles app', summary: 's', description: 'd', launchUrl: 'https://app.example/launch',
			redirectUris: [redirectUri], scopes: ['openid', 'launch', 'patient/Patient.rs', 'online_access'], placement: 'ingen',
			contactEmail: '', privacyUrl: '', databehandleravtale: '', clientType: 'secret'
		});
		secret = (await firstAppSecret(id, 'dev1')) as string;
		await submitApp(id, 'dev1');
		await reviewApp(id, true, 'ok', null);
		const app = (await getCatalogueApp(id))!;
		clientId = app.client_id;
		await withTenant(a, () => installApp(app, null));
		await withTenant(b, () => installApp(app, null));
	});

	const issue = (tenant: Tenant) =>
		withTenant(tenant, async () => {
			const code = await createAuthorisationCode({
				clientId, userId: `u-${tenant.id}`, redirectUri, scope: 'openid launch patient/Patient.rs online_access',
				codeChallenge: pkceChallenge(verifier), codeChallengeMethod: 'S256', launch: {}
			});
			const client = (await getClient(clientId))!;
			const result = await exchangeInCode(code, client, redirectUri, verifier);
			if (!result.ok) throw new Error(result.description);
			return result.tokens;
		});

	const tokenPost = (body: Record<string, string>) =>
		new Request('https://felles.epj.test/oauth/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body).toString()
		});

	it('has the same client id and secret in every practice, known before anyone installs it', async () => {
		for (const tenant of [a, b]) {
			const client = await withTenant(tenant, () => getClient(clientId));
			expect(client?.tenant_id).toBe(tenant.id);
			const auth = await withTenant(tenant, () =>
				authenticateClient(new URLSearchParams({ client_id: clientId, client_secret: secret }), null)
			);
			expect(auth.ok).toBe(true);
		}
	});

	it('says which practice a token is for the way WebMed does, under the id the app looks up', async () => {
		for (const tenant of [a, b]) {
			const { access_token } = await issue(tenant);
			expect(decodeWithoutVerification(access_token)?.payload.smart_app_officeApiUrl).toBe(tenant.id);
		}
	});

	it('finds the practice from the code, for a token exchange that has no session', async () => {
		const code = await withTenant(b, () =>
			createAuthorisationCode({
				clientId, userId: 'u-legekontor-b', redirectUri, scope: 'launch',
				codeChallenge: pkceChallenge(verifier), codeChallengeMethod: 'S256', launch: {}
			})
		);
		expect(await tenantIdForCredential(tokenPost({ grant_type: 'authorization_code', code }), '/oauth/token')).toBe(b.id);
	});

	it('finds the practice from a bearer token and a refresh token', async () => {
		const tokens = await issue(b);
		const fhir = new Request('https://felles.epj.test/fhir/Patient', { headers: { authorization: `Bearer ${tokens.access_token}` } });
		expect(await tenantIdForCredential(fhir, '/fhir/Patient')).toBe(b.id);
		const refresh = tokenPost({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token as string });
		expect(await tenantIdForCredential(refresh, '/oauth/token')).toBe(b.id);
	});

	it('leaves the body readable for the endpoint itself', async () => {
		const request = tokenPost({ code: 'x' });
		await tenantIdForCredential(request, '/oauth/token');
		expect(await request.text()).toBe('code=x');
	});

	it('finds nothing from a value it did not issue, so the request stays where it was', async () => {
		const fhir = new Request('https://felles.epj.test/fhir/Patient', { headers: { authorization: 'Bearer invented' } });
		expect(await tenantIdForCredential(fhir, '/fhir/Patient')).toBeNull();
		expect(await tenantIdForCredential(tokenPost({ code: 'invented' }), '/oauth/token')).toBeNull();
		expect(await tenantIdForCredential(tokenPost({ code: 'x' }), '/logg-inn')).toBeNull();
	});

	it('does not let a token or a code from one practice work in another', async () => {
		const tokens = await issue(a);
		expect((await withTenant(b, () => validateAccessToken(tokens.access_token))).valid).toBe(false);
		expect((await withTenant(a, () => validateAccessToken(tokens.access_token))).valid).toBe(true);
		expect((await withTenant(b, () => renewWithRefreshToken(tokens.refresh_token as string, clientId))).ok).toBe(false);

		const code = await withTenant(a, () =>
			createAuthorisationCode({
				clientId, userId: 'u-standard', redirectUri, scope: 'launch',
				codeChallenge: pkceChallenge(verifier), codeChallengeMethod: 'S256', launch: {}
			})
		);
		const inB = await withTenant(b, async () => exchangeInCode(code, (await getClient(clientId))!, redirectUri, verifier));
		expect(inB.ok).toBe(false);
	});

	it('blocks it in one practice and leaves the other alone', async () => {
		const inA = await issue(a);
		const inB = await issue(b);
		await withTenant(a, () => setKlientstatus(clientId, 'sperret'));

		expect((await withTenant(a, () => getClient(clientId)))?.status).toBe('sperret');
		expect((await withTenant(b, () => getClient(clientId)))?.status).toBe('aktiv');
		expect((await withTenant(a, () => validateAccessToken(inA.access_token))).valid).toBe(false);
		expect((await withTenant(b, () => validateAccessToken(inB.access_token))).valid).toBe(true);
	});

	it('can be removed and installed again, with the same id, and asks again', async () => {
		const app = (await one<{ id: string }>('SELECT id FROM catalogue_app'))!;
		await exec(
			`INSERT INTO oauth_consent (id, tenant_id, user_id, client_id, scopes) VALUES ('c1', $1, 'u-standard', $2, 'launch')`,
			[a.id, clientId]
		);
		const old = await issue(a);
		await withTenant(a, () => uninstallApp(app.id));
		expect((await withTenant(a, () => getClient(clientId)))?.status).toBe('sperret');

		const again = await withTenant(a, async () => installApp((await getCatalogueApp(app.id))!, null));
		expect(again.clientId).toBe(clientId);
		expect((await withTenant(a, () => getClient(clientId)))?.status).toBe('aktiv');
		expect(await one('SELECT id FROM oauth_consent WHERE id = $1', ['c1'])).toBeNull();
		expect((await withTenant(a, () => validateAccessToken(old.access_token))).valid).toBe(false);
		expect((await withTenant(b, () => getClient(clientId)))?.status).toBe('aktiv');
	});

	it('publishes the keys of everyone on the address, so an id_token from any of them verifies', async () => {
		const fromA = decodeWithoutVerification((await issue(a)).access_token);
		const fromB = decodeWithoutVerification((await issue(b)).access_token);
		const kids = (await withTenant(a, () => publishedJwks())).keys.map((k) => k.kid);
		expect(kids).toContain(fromA?.header.kid);
		expect(kids).toContain(fromB?.header.kid);
	});

	it('keeps a practice with an address of its own out of that, and its keys to itself', async () => {
		await exec("UPDATE tenant SET hostname = 'b.epj.test', base_url = 'https://b.epj.test' WHERE id = 'legekontor-b'");
		const own = (await getTenant('legekontor-b')) as Tenant;
		const fromOwn = decodeWithoutVerification((await issue(own)).access_token);
		expect((await withTenant(a, () => publishedJwks())).keys.map((k) => k.kid)).not.toContain(fromOwn?.header.kid);
		expect((await withTenant(own, () => publishedJwks())).keys.map((k) => k.kid)).toContain(fromOwn?.header.kid);
	});
});
