import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Organisation context.
 *
 * One installation serves several practices. Which organisation a request
 * concerns is derived from the hostname in `hooks.server.ts`, and placed here
 * for the rest of the request. The user never picks the organisation - that
 * choice would be an attack surface.
 *
 * `requireTenant()` throws if the context is missing. That is deliberate: a
 * query that should have been bounded to one organisation must fail loudly in
 * tests, not quietly return someone else's data.
 */

export interface Tenant {
	id: string;
	name: string;
	organisation_number: string;
	her_id: string | null;
	municipality_code: string | null;
	hostname: string | null;
	base_url: string;
	/** The partition in HAPI FHIR. NULL for system organisations with no clinical data. */
	partition_id: number | null;
	status: 'aktiv' | 'suspendert' | 'avviklet';
	/** Weakest sign-in method the organisation accepts: epost, passord, helseid. */
	login_level: string;
	note: string | null;
	created_at: string;
}

/** The organisation platform administration's own actions are logged against. */
export const PLATFORM_TENANT = 'plattform';

const store = new AsyncLocalStorage<Tenant>();

/** Runs `fn` with the organisation set in context. */
export function withTenant<T>(t: Tenant, fn: () => T): T {
	return store.run(t, fn);
}

/**
 * Sets the organisation for the current execution context and everything that
 * springs from it, without an enclosing function.
 *
 * Exists for test setup and for scripts that run in one organisation from start
 * to finish. The application uses `withTenant`, which bounds the context to a
 * single request.
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

/** Organisation id for use in queries. */
export function time(): string {
	return requireTenant().id;
}

/** Outward-facing FHIR base for the organisation. Used as `aud` in tokens. */
export function fhirBaseFor(t: Tenant): string {
	return `${t.base_url.replace(/\/$/, '')}/fhir`;
}

export function issuerFor(t: Tenant): string {
	return t.base_url.replace(/\/$/, '');
}
