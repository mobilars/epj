import { fhirClient } from '../fhir/client';
import { log } from '../audit';
import { requireTenant } from '../tenant/context';
import { newId } from '../util/ids';

/**
 * Finding patients by phone number, however the number was written.
 *
 * The record stores a phone number as it was typed - `99887766`,
 * `998 87 766`, `+47 99 88 77 66`, `tlf 99887766 (mor)` - and a FHIR search
 * matches the text exactly. Guessing spellings can never be complete, so
 * numbers are compared by what they are instead: every number is reduced to its
 * digits with a country code, and two numbers are the same when those match.
 *
 * FHIR cannot search on a reduced form, so the reduced numbers are kept in a
 * small table in memory, one per practice: which patients have which number.
 * It is built by reading the phone numbers of the practice's patients, lives
 * only in this process, and is thrown away after a few minutes. Nothing new is
 * stored anywhere.
 *
 * The table says only which patients to ask for. They are then fetched through
 * the gateway as the user, so who may see whom is decided there, as for any
 * other search - a number on a restricted record finds nothing for someone who
 * may not see it.
 */

/** Country code assumed for a number written without one. */
const HOME = '47';

/** How long a built table is trusted before it is read again. */
const LIFETIME_MS = 5 * 60 * 1000;

/** HAPI's `max_page_size` in the manifests. */
const PAGE = 200;

/** A practice has thousands of patients, not millions. Stop rather than run away. */
const MAX_PATIENTS = 50_000;

/**
 * One run of digits as a comparable number: digits only, country code first.
 * Null when it cannot be a phone number.
 */
function keyFor(digits: string, international: boolean): string | null {
	let key = digits;
	if (!international) {
		// Eight digits not starting with 0 or 1 is a Norwegian number.
		if (/^[2-9]\d{7}$/.test(key)) key = HOME + key;
		// Ten digits starting with 47 is one somebody wrote without the plus.
		else if (!/^47[2-9]\d{7}$/.test(key)) {
			// Anything else is compared as it stands, without a leading zero.
			key = key.replace(/^0+/, '');
		}
	}
	return /^\d{5,15}$/.test(key) ? key : null;
}

/**
 * Every phone number in a piece of text, as comparable numbers.
 *
 * Takes what a person might type into a phone field, including two numbers in
 * one field and a note beside them. Spaces, hyphens, dots, slashes inside a
 * number and parentheses are ignored; a `+` or `00` in front marks a country
 * code.
 */
export function phoneKeys(text: unknown): string[] {
	if (typeof text !== 'string') return [];
	const keys = new Set<string>();
	// A run that starts with an optional international prefix and a digit, and
	// carries on through digits and the punctuation people put between them.
	const runs = text.replace(/ /g, ' ').match(/(?:\+|00)?\(?\d[\d\s\-.()]*\d/g) ?? [];
	for (const run of runs) {
		const compact = run.replace(/[^\d+]/g, '');
		const international = compact.startsWith('+') || compact.startsWith('00');
		let digits = compact.replace(/\D/g, '');
		if (compact.startsWith('00')) digits = digits.slice(2);

		if (!international && digits.length > 8 && digits.length % 8 === 0 && !/^47[2-9]\d{7}$/.test(digits)) {
			// Two or more Norwegian numbers typed with only a space between them.
			for (let i = 0; i < digits.length; i += 8) {
				const key = keyFor(digits.slice(i, i + 8), false);
				if (key) keys.add(key);
			}
			continue;
		}
		const key = keyFor(digits, international);
		if (key) keys.add(key);
	}
	return [...keys];
}

/**
 * The number a caller's exchange sent, as a comparable number, or null.
 *
 * Generous on purpose: an exchange sends what it has - with `tel:` in front,
 * with spaces, with a country code in either spelling. `anonymous`, an empty
 * string and an internal extension are not numbers and give null.
 */
export function lookupKey(input: unknown): string | null {
	if (typeof input !== 'string' || input.length > 64) return null;
	const keys = phoneKeys(input.trim().replace(/^tel:/i, ''));
	return keys.length === 1 ? keys[0] : null;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface Table {
	builtAt: number;
	/** False when the practice's patients could not all be read. */
	complete: boolean;
	patients: number;
	byNumber: Map<string, Set<string>>;
}

const tables = new Map<string, Table>();
const building = new Map<string, Promise<Table>>();

type Telecom = { system?: string; value?: string };

/** Adds one patient's numbers to a table. Exported for the tests. */
export function addPatient(byNumber: Map<string, Set<string>>, id: string, telecom: unknown): void {
	for (const t of (Array.isArray(telecom) ? telecom : []) as Telecom[]) {
		// `sms` is a number too. Email, url and the rest are not.
		if (t?.system && t.system !== 'phone' && t.system !== 'sms') continue;
		for (const key of phoneKeys(t?.value)) {
			let ids = byNumber.get(key);
			if (!ids) byNumber.set(key, (ids = new Set()));
			ids.add(id);
		}
	}
}

async function build(tenantId: string): Promise<Table> {
	const byNumber = new Map<string, Set<string>>();
	const seen = new Set<string>();
	let complete = true;

	for (let offset = 0; offset < MAX_PATIENTS; offset += PAGE) {
		const bundle = await fhirClient.searchPost(
			'Patient',
			new URLSearchParams({ _count: String(PAGE), _offset: String(offset), _sort: '_lastUpdated', _elements: 'telecom' })
		);
		const page = (bundle.entry ?? []).map((e) => e.resource).filter(Boolean) as { id?: string; telecom?: unknown }[];
		let added = 0;
		for (const patient of page) {
			if (!patient.id || seen.has(patient.id)) continue;
			seen.add(patient.id);
			added++;
			addPatient(byNumber, patient.id, patient.telecom);
		}
		if (page.length < PAGE) break;
		if (added === 0) {
			// A full page of patients already seen: the server is not honouring
			// the offset. What has been read is still right, only not everything.
			complete = false;
			break;
		}
	}

	// Read on the record's own behalf, not a user's, and said so in the log.
	await log(
		{
			type: 'system',
			subtype: 'telefonoppslag:tabell',
			action: 'E',
			outcome: '0',
			details: { patients: seen.size, numbers: byNumber.size, complete }
		},
		{ userId: null, actorRef: 'Device/epj', name: 'EPJ', role: null, clientId: null, ip: '', requestId: newId() },
		tenantId
	).catch(() => undefined);

	return { builtAt: Date.now(), complete, patients: seen.size, byNumber };
}

async function tableFor(tenantId: string): Promise<Table> {
	const current = tables.get(tenantId);
	if (current && Date.now() - current.builtAt < LIFETIME_MS) return current;

	// One read at a time per practice, however many calls come in at once.
	let pending = building.get(tenantId);
	if (!pending) {
		pending = build(tenantId)
			.then((table) => {
				tables.set(tenantId, table);
				return table;
			})
			.finally(() => building.delete(tenantId));
		building.set(tenantId, pending);
	}
	return pending;
}

/**
 * The ids of the patients in this practice who have the number, by any
 * spelling. Empty when there are none - or when the table could not be built,
 * which the caller covers with an ordinary search and must not treat as proof
 * that nobody has the number.
 */
export async function patientIdsWithPhone(key: string): Promise<{ ids: string[]; complete: boolean }> {
	try {
		const table = await tableFor(requireTenant().id);
		return { ids: [...(table.byNumber.get(key) ?? [])], complete: table.complete };
	} catch {
		return { ids: [], complete: false };
	}
}

/** Forgets what has been read. For the tests, and for a patient just registered. */
export function forgetPhoneTable(tenantId?: string): void {
	if (tenantId) tables.delete(tenantId);
	else tables.clear();
}
