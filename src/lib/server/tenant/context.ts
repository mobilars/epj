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
	name: string;
	organisation_number: string;
	her_id: string | null;
	municipality_code: string | null;
	hostname: string | null;
	base_url: string;
	/** Partisjonen i HAPI FHIR. NULL for systemvirksomheter uten kliniske data. */
	partition_id: number | null;
	status: 'aktiv' | 'suspendert' | 'avviklet';
	note: string | null;
	created_at: string;
}

/** Virksomheten plattformadministrasjonens egne handlinger loggføres på. */
export const PLATFORM_TENANT = 'plattform';

const store = new AsyncLocalStorage<Tenant>();

/** Kjører `fn` med virksomheten satt i konteksten. */
export function withTenant<T>(t: Tenant, fn: () => T): T {
	return store.run(t, fn);
}

/**
 * Setter virksomheten for gjeldende utførelseskontekst og alt som springer ut
 * av den, uten en omsluttende funksjon.
 *
 * Finnes for testoppsett og for skript som kjører i én virksomhet fra start til
 * slutt. Applikasjonen bruker `medTenant`, som avgrenser konteksten til én
 * forespørsel.
 */
export function setTenant(t: Tenant): void {
	store.enterWith(t);
}

export function currentTenant(): Tenant | undefined {
	return store.getStore();
}

export function requireTenant(): Tenant {
	const t = store.getStore();
	if (!t) {
		throw new Error(
			'Ingen virksomhetskontekst. Spørringen ville ikke vært avgrenset til én virksomhet.'
		);
	}
	return t;
}

/** Virksomhets-id for bruk i spørringer. */
export function time(): string {
	return requireTenant().id;
}

/** Utadvendt FHIR-base for virksomheten. Brukes som `aud` i tokens. */
export function fhirBaseFor(t: Tenant): string {
	return `${t.base_url.replace(/\/$/, '')}/fhir`;
}

export function issuerFor(t: Tenant): string {
	return t.base_url.replace(/\/$/, '');
}
