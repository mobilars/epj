import { one } from '../db';
import { tokenHash } from '../util/crypto';

/**
 * Which organisation a code or token on a shared address belongs to.
 *
 * Practices can share one address and so one `iss`, the way WebMed's customers do. A
 * person there is placed by their session, but an app's server has none: its token
 * exchange and its FHIR calls carry only what the record issued to it. So that is what
 * places them.
 *
 * Deliberately across organisations, and still not something a client can choose: the
 * lookup is by the hash of a secret value the record itself handed out, and whatever it
 * finds is then checked in full inside that organisation, signature and client included.
 */
export async function tenantIdForCredential(request: Request, path: string): Promise<string | null> {
	const authorization = request.headers.get('authorization');
	if (authorization?.toLowerCase().startsWith('bearer ')) {
		return tenantOfToken(authorization.slice(7).trim(), 'access');
	}
	if (request.method !== 'POST' || !path.startsWith('/oauth/')) return null;
	if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return null;

	const form = new URLSearchParams(await request.clone().text());
	if (path === '/oauth/token') {
		const code = form.get('code');
		if (code) {
			const row = await one<{ tenant_id: string }>('SELECT tenant_id FROM oauth_authorization_code WHERE code_hash = $1', [tokenHash(code)]);
			return row?.tenant_id ?? null;
		}
		const refreshToken = form.get('refresh_token');
		return refreshToken ? tenantOfToken(refreshToken, 'refresh') : null;
	}
	if (path === '/oauth/revoke' || path === '/oauth/introspect') {
		const token = form.get('token');
		return token ? tenantOfToken(token) : null;
	}
	return null;
}

async function tenantOfToken(token: string, kind?: 'access' | 'refresh'): Promise<string | null> {
	const row = await one<{ tenant_id: string }>(
		`SELECT tenant_id FROM oauth_token WHERE token_hash = $1 AND ${kind ? 'kind = $2' : "kind IN ('access', 'refresh')"}`,
		kind ? [tokenHash(token), kind] : [tokenHash(token)]
	);
	return row?.tenant_id ?? null;
}
