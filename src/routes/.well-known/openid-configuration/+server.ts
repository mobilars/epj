import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireTenant, issuerFor } from '$srv/tenant/context';

/** OpenID Connect discovery, used by apps signing in with the `openid` scope. */
export const GET: RequestHandler = () => {
	const base = issuerFor(requireTenant());
	return json(
		{
			issuer: base,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/oauth/token`,
			jwks_uri: `${base}/oauth/jwks`,
			introspection_endpoint: `${base}/oauth/introspect`,
			revocation_endpoint: `${base}/oauth/revoke`,
			userinfo_endpoint: `${base}/oauth/userinfo`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['ES256'],
			scopes_supported: ['openid', 'profile', 'fhirUser', 'email', 'offline_access'],
			claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'name', 'fhirUser', 'roles'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt']
		},
		{ headers: { 'cache-control': 'public, max-age=300' } }
	);
};
