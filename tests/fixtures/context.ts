import type { Tenant } from '../../src/lib/server/tenant/context';
import type { AuthContext } from '../../src/lib/server/authz/context';
import { parseScopes } from '../../src/lib/server/authz/scopes';
import { permissionsForRoles, scopesForRoles, type Role } from '../../src/lib/server/authz/roles';

/** Bygger en tilgangskontekst for testene, med rollens fulle scope-sett. */
export function context(over: Partial<AuthContext> & { roles?: Role[] } = {}): AuthContext {
	const roles = over.roles ?? (['lege'] as Role[]);
	return {
		mate: 'session',
		userId: 'bruker-1',
		actorRef: 'Practitioner/42',
		name: 'Dr. Ingrid Fastlege',
		roles,
		permissions: permissionsForRoles(roles),
		scopes: parseScopes([...scopesForRoles(roles)].join(' ')),
		clientId: null,
		clientName: 'EPJ',
		launch: {},
		sessionId: 'sesjon-1',
		tokenId: null,
		amr: 'pwd+otp',
		elevatedTo: null,
		ip: '192.0.2.10',
		requestId: 'req-test',
		...over
	};
}

/** Kontekst for en SMART-app med et bestemt scope-sett og pasientkontekst. */
export function appContext(scope: string, patientId?: string, roles: Role[] = ['lege']): AuthContext {
	return context({
		mate: 'smart-app',
		clientId: 'app-1',
		clientName: 'Testapp',
		scopes: parseScopes(scope),
		launch: { patientId: patientId ?? null },
		roles
	});
}


/**
 * Virksomhetene testene kjører i.
 *
 * `TEST_TENANT` speiler standardvirksomheten migrasjon 003 legger inn. Den
 * andre finnes for isolasjonstestene: alt som skrives i den ene skal være
 * usynlig fra den andre.
 */
export const TEST_TENANT: Tenant = {
	id: 'standard',
	name: 'Standardvirksomhet',
	organisation_number: '999999999',
	her_id: '8000001',
	municipality_code: null,
	hostname: null,
	base_url: 'http://localhost:5173',
	partition_id: 1,
	status: 'aktiv',
	note: null,
	created_at: new Date(0).toISOString()
};

export const ANNEN_TENANT: Tenant = {
	...TEST_TENANT,
	id: 'annen',
	name: 'Annen virksomhet',
	organisation_number: '994598759',
	her_id: '8000002',
	base_url: 'http://annen.localhost:5173',
	partition_id: 2
};
