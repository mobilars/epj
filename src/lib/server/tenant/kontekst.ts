import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Virksomhetskontekst.
 *
 * Én installasjon betjener flere legekontorer. Hvilken virksomhet en
 * forespørsel gjelder utledes av vertsnavnet i `hooks.server.ts`, og legges her
 * for resten av forespørselen. Brukeren velger aldri virksomhet selv - da ville
 * valget vært en angrepsflate.
 *
 * `krevTenant()` kaster hvis konteksten mangler. Det er med vilje: en spørring
 * som skulle vært avgrenset til én virksomhet skal feile høylytt i test, ikke
 * stille returnere andres data.
 */

export interface Tenant {
	id: string;
	navn: string;
	organisasjonsnummer: string;
	her_id: string | null;
	kommunenummer: string | null;
	vertsnavn: string | null;
	base_url: string;
	partisjon_id: number;
	status: 'aktiv' | 'suspendert' | 'avviklet';
	merknad: string | null;
	opprettet: string;
}

/** Virksomheten plattformadministrasjonens egne handlinger loggføres på. */
export const PLATTFORM_TENANT = 'plattform';

const lager = new AsyncLocalStorage<Tenant>();

/** Kjører `fn` med virksomheten satt i konteksten. */
export function medTenant<T>(t: Tenant, fn: () => T): T {
	return lager.run(t, fn);
}

/**
 * Setter virksomheten for gjeldende utførelseskontekst og alt som springer ut
 * av den, uten en omsluttende funksjon.
 *
 * Finnes for testoppsett og for skript som kjører i én virksomhet fra start til
 * slutt. Applikasjonen bruker `medTenant`, som avgrenser konteksten til én
 * forespørsel.
 */
export function settTenant(t: Tenant): void {
	lager.enterWith(t);
}

export function gjeldendeTenant(): Tenant | undefined {
	return lager.getStore();
}

export function krevTenant(): Tenant {
	const t = lager.getStore();
	if (!t) {
		throw new Error(
			'Ingen virksomhetskontekst. Spørringen ville ikke vært avgrenset til én virksomhet.'
		);
	}
	return t;
}

/** Virksomhets-id for bruk i spørringer. */
export function tid(): string {
	return krevTenant().id;
}

/** Utadvendt FHIR-base for virksomheten. Brukes som `aud` i tokens. */
export function fhirBaseFor(t: Tenant): string {
	return `${t.base_url.replace(/\/$/, '')}/fhir`;
}

export function utstederFor(t: Tenant): string {
	return t.base_url.replace(/\/$/, '');
}
