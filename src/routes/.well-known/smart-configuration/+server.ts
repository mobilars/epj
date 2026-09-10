import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$srv/config';
import { fhirBaseFor, requireTenant, issuerFor } from '$srv/tenant/context';

/**
 * SMART on FHIR discovery (`.well-known/smart-configuration`).
 *
 * The Directorate of Health's recommendation HITR 1225 points to SMART App
 * Launch as the standard for third-party apps against record systems. The
 * document below announces which parts of SMART this record supports.
 */
export const GET: RequestHandler = () => {
	// The metadata is per organisation: each has its own `issuer` and its own FHIR
	// endpoint, and an app approved at one is not approved at another.
	const tenant = requireTenant();
	const base = issuerFor(tenant);
	return json(
		{
			issuer: base,
			fhir_endpoint: fhirBaseFor(tenant),
			jwks_uri: `${base}/oauth/jwks`,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/oauth/token`,
			introspection_endpoint: `${base}/oauth/introspect`,
			revocation_endpoint: `${base}/oauth/revoke`,
			registration_endpoint: `${base}/oauth/register`,
			management_endpoint: `${base}/admin/apper`,
			token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
			token_endpoint_auth_signing_alg_values_supported: ['ES256'],
			grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
			scopes_supported: [
				'openid', 'profile', 'fhirUser', 'launch', 'launch/patient', 'launch/encounter',
				'offline_access', 'online_access',
				'patient/*.rs', 'user/*.rs', 'user/*.cruds', 'system/*.rs',
				'patient/Patient.rs', 'patient/Observation.rs', 'patient/Condition.rs',
				'patient/MedicationRequest.rs', 'patient/AllergyIntolerance.rs', 'patient/Immunization.rs',
				'user/Patient.rs', 'user/Encounter.cruds', 'user/Observation.cruds', 'user/Condition.cruds'
			],
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			capabilities: [
				'launch-ehr',
				'launch-standalone',
				'client-public',
				'client-confidential-symmetric',
				'client-confidential-asymmetric',
				'sso-openid-connect',
				'context-banner',
				'context-style',
				'context-ehr-patient',
				'context-ehr-encounter',
				'context-standalone-patient',
				'permission-patient',
				'permission-user',
				'permission-offline',
				'permission-online',
				'permission-v1',
				'permission-v2',
				'authorize-post'
			],
			// The record always requires PKCE, confidential clients included.
			require_pkce: true
		},
		{ headers: { 'cache-control': 'public, max-age=300' } }
	);
};
