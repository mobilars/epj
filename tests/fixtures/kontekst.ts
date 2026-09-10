import type { Tenant } from '../../src/lib/server/tenant/kontekst';
import type { AuthContext } from '../../src/lib/server/authz/context';
import { parseScopes } from '../../src/lib/server/authz/scopes';
import { rettigheterForRoller, scopesForRoller, type Rolle } from '../../src/lib/server/authz/roles';

/** Bygger en tilgangskontekst for testene, med rollens fulle scope-sett. */
export function kontekst(over: Partial<AuthContext> & { roller?: Rolle[] } = {}): AuthContext {
	const roller = over.roller ?? (['lege'] as Rolle[]);
	return {
		mate: 'session',
		userId: 'bruker-1',
		actorRef: 'Practitioner/42',
		navn: 'Dr. Ingrid Fastlege',
		roller,
		rettigheter: rettigheterForRoller(roller),
		scopes: parseScopes([...scopesForRoller(roller)].join(' ')),
		clientId: null,
		clientNavn: 'EPJ',
		launch: {},
		sessionId: 'sesjon-1',
		tokenId: null,
		amr: 'pwd+otp',
		elevertTil: null,
		ip: '192.0.2.10',
		requestId: 'req-test',
		...over
	};
}

/** Kontekst for en SMART-app med et bestemt scope-sett og pasientkontekst. */
export function appKontekst(scope: string, patientId?: string, roller: Rolle[] = ['lege']): AuthContext {
	return kontekst({
		mate: 'smart-app',
		clientId: 'app-1',
		clientNavn: 'Testapp',
		scopes: parseScopes(scope),
		launch: { patientId: patientId ?? null },
		roller
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
	navn: 'Standardvirksomhet',
	organisasjonsnummer: '999999999',
	her_id: '8000001',
	kommunenummer: null,
	vertsnavn: null,
	base_url: 'http://localhost:5173',
	partisjon_id: 1,
	status: 'aktiv',
	merknad: null,
	opprettet: new Date(0).toISOString()
};

export const ANNEN_TENANT: Tenant = {
	...TEST_TENANT,
	id: 'annen',
	navn: 'Annen virksomhet',
	organisasjonsnummer: '994598759',
	her_id: '8000002',
	base_url: 'http://annen.localhost:5173',
	partisjon_id: 2
};
