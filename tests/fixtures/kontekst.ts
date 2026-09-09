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
