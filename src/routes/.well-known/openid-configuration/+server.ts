import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$srv/config';

/** OpenID Connect discovery, brukt av apper som logger inn med `openid`-scope. */
export const GET: RequestHandler = () =>
	json(
		{
			issuer: config.issuer,
			authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
			token_endpoint: `${config.baseUrl}/oauth/token`,
			jwks_uri: `${config.baseUrl}/oauth/jwks`,
			introspection_endpoint: `${config.baseUrl}/oauth/introspect`,
			revocation_endpoint: `${config.baseUrl}/oauth/revoke`,
			userinfo_endpoint: `${config.baseUrl}/oauth/userinfo`,
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
