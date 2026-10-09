/**
 * Opening a patient's record from another program.
 *
 * A switchboard, a queue system or a laboratory client knows which patient
 * someone is asking about before the record does. This is the address such a
 * program opens in the user's browser to land on that patient: it carries no
 * credentials and grants nothing. It only saves the clinician the search, and
 * everything the record would normally check is still checked by the page it
 * leads to.
 *
 * Three rules shape it.
 *
 * It works only on a session that was signed in with HelseID. A link is opened
 * by whichever program the workstation runs, at a moment the user did not
 * choose; it must never be the reason someone is signed in, and never ride on
 * a weaker sign-in than the one the record trusts.
 *
 * A `fødselsnummer` (national identity number) never goes in the query string.
 * Query strings are written to access logs by every proxy on the way, and stay
 * in browser history. The record's own id can go there; the national number
 * travels in the URL fragment, which a browser never sends to a server, and is
 * posted from the page once it has been wiped from the address bar.
 *
 * A link followed from another website is not opened straight away. Anything a
 * browser will navigate to can be linked from anywhere, and each opening is a
 * logged lookup in the clinician's name. A program on the workstation and the
 * record itself go straight through; another site gets a question first.
 */

export const OPEN_PATH = '/apne/pasient';

/** FHIR's own rule for a logical id. */
const PATIENT_ID = /^[A-Za-z0-9\-.]{1,64}$/;

/** The names an integrator might reach for when putting the number in the query. */
const IDENTITY_IN_QUERY = ['fnr', 'fodselsnummer', 'fødselsnummer', 'personnummer', 'ssn', 'identifier', 'dnr'];

export function isPatientId(value: unknown): value is string {
	return typeof value === 'string' && PATIENT_ID.test(value);
}

/** Eleven digits. Whether they are a valid number is the caller's check. */
export function isIdentityNumberShape(value: unknown): value is string {
	return typeof value === 'string' && /^\d{11}$/.test(value);
}

/** True when the query string carries something that looks like a national identity number. */
export function identityInQuery(params: URLSearchParams): boolean {
	for (const [key, value] of params) {
		if (IDENTITY_IN_QUERY.includes(key.toLowerCase())) return true;
		// Eleven digits and nothing else is an identity number whatever the
		// parameter is called - `id=01010112345` included. The record's own ids
		// are short sequence numbers or UUIDs, never this.
		if (/^\d{11}$/.test(value.trim())) return true;
	}
	return false;
}

/**
 * Who asked, for the log. A short label the integrator chooses, such as
 * `callmanager`. Anything else is dropped rather than logged as it came.
 */
export function sourceLabel(value: unknown): string | null {
	return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value) ? value : null;
}

/**
 * Whether the user has to confirm before the record is opened.
 *
 * `Sec-Fetch-Site` says where a navigation came from, and a page cannot set
 * it. `none` is a navigation the user or a local program started; `same-origin`
 * is the record itself. Everything else - another site, a sibling hostname, or
 * a browser too old to say - is asked first.
 */
export function needsConfirmation(secFetchSite: string | null): boolean {
	return !(secFetchSite === 'none' || secFetchSite === 'same-origin');
}

/** The address that opens a patient by the record's own id. */
export function openUrlForId(id: string, source: string | null): string {
	const params = new URLSearchParams({ id });
	if (source) params.set('kilde', source);
	return `${OPEN_PATH}?${params}`;
}
