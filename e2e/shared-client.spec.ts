import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';

/**
 * An app's server on an address practices share, with one client id for all of them.
 *
 * Real HTTP through the record's own hooks, with no session, which is how an app's
 * server calls: the practice can only come from the code and the token it carries.
 */
test('a practice that is not the default is found from the code and the token, on the shared address', async ({ request }) => {
	const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
	await db.connect();
	const tenantId = 'felles-b';
	const clientId = `epj-felles-${randomBytes(6).toString('hex')}`;
	const redirectUri = 'https://app.example/cb';
	const verifier = randomBytes(32).toString('base64url');
	const code = randomBytes(32).toString('base64url');
	// As the record hashes a code, under the data key playwright.config.ts gives it.
	const codeHash = createHmac('sha256', scryptSync('e2e-nokkel-kun-for-testkjoring-00000000', 'epj-data-key-v1', 32)).update(code).digest('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');

	const { rows } = await db.query<{ base_url: string }>("SELECT base_url FROM epj.tenant WHERE id = 'standard'");
	// No partition: it holds nothing clinical, and the security log, which cannot be
	// deleted from, may keep this row after the test.
	await db.query(
		`INSERT INTO epj.tenant (id, name, organisation_number, base_url, partition_id) VALUES ($1, 'Felles B', '994598759', $2, NULL)`,
		[tenantId, rows[0].base_url]
	);
	try {
		await db.query('INSERT INTO epj.user_account (id, tenant_id, username, name) VALUES ($1, $2, $3, $4)', ['felles-lege', tenantId, 'lege', 'Lege B']);
		await db.query(
			`INSERT INTO epj.role_assignment (id, user_id, role, assigned_by) VALUES ('felles-rolle', 'felles-lege', 'behandler', 'felles-lege')`
		);
		// In both practices, under the one id. Only the row in the practice the code
		// belongs to may answer.
		for (const tenant of ['standard', tenantId]) {
			await db.query(
				`INSERT INTO epj.oauth_client (client_id, tenant_id, name, type, client_category, redirect_uris, allowed_scopes, grant_types)
				 VALUES ($1, $2, 'Felles', 'public', 'smart-ehr', $3, '["launch","patient/Patient.rs"]', '["authorization_code"]')`,
				[clientId, tenant, JSON.stringify([redirectUri])]
			);
		}
		await db.query(
			`INSERT INTO epj.oauth_authorization_code
			 (code_hash, tenant_id, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at)
			 VALUES ($1, $2, $3, 'felles-lege', $4, 'launch patient/Patient.rs', $5, 'S256', now() + interval '5 minutes')`,
			[codeHash, tenantId, clientId, redirectUri, challenge]
		);

		const exchanged = await request.post('/oauth/token', {
			form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }
		});
		expect(exchanged.status()).toBe(200);
		const tokens = await exchanged.json();
		expect(tokens.tenant).toBe(tenantId);
		const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
		expect(claims.smart_app_officeApiUrl).toBe(tenantId);

		// Past the token check: the call is treated as this practice's, not refused as
		// a token from another.
		const fhir = await request.get('/fhir/Patient/ingen', { headers: { authorization: `Bearer ${tokens.access_token}` } });
		expect(fhir.status()).not.toBe(401);

		const keys = await (await request.get('/oauth/jwks')).json();
		const header = JSON.parse(Buffer.from(tokens.access_token.split('.')[0], 'base64url').toString());
		expect(keys.keys.map((k: { kid: string }) => k.kid)).toContain(header.kid);
	} finally {
		for (const sql of [
			'DELETE FROM epj.audit_event WHERE tenant_id = $1',
			'DELETE FROM epj.oauth_token WHERE tenant_id = $1',
			'DELETE FROM epj.oauth_authorization_code WHERE tenant_id = $1',
			'DELETE FROM epj.oauth_client WHERE tenant_id = $1',
			'DELETE FROM epj.signing_key WHERE tenant_id = $1',
			"DELETE FROM epj.role_assignment WHERE id = 'felles-rolle'",
			'DELETE FROM epj.user_account WHERE tenant_id = $1',
			'DELETE FROM epj.tenant WHERE id = $1'
		]) {
			await db.query(sql, sql.includes('$1') ? [tenantId] : []).catch(() => undefined);
		}
		await db.query('DELETE FROM epj.oauth_client WHERE client_id = $1', [clientId]);
		await db.end();
	}
});
