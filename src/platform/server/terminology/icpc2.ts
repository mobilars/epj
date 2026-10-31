import table from './icpc2.json';
import { SYSTEM } from '../fhir/codesystems';
import { createSmartSearch, type SmartHit } from './icpc2-search';

/**
 * ICPC-2, the Norwegian edition, as published by Helsedirektoratet.
 *
 * ICPC-2 is the classification a general practice reports in: the diagnosis
 * on every settlement card to Helfo (KUHR) is an ICPC-2 code, and the
 * Directorate's guidance is that it is the primary classification in primary
 * care, with ICD-10 for referrals and hospital communication. The record used
 * to take the code as free text, which is how a note ends up filed under a
 * code that does not exist.
 *
 * The table is the Directorate's own, fetched from the kodeverk API behind
 * Finnkode and bundled, so lookup and search work without a network round trip
 * and without a dependency on a service being up at the moment a note is
 * written. `fetched` says which edition; refresh by re-running the fetch.
 */

export interface Icpc2Code {
	code: string;
	/** Norwegian name, the one shown in the record. */
	display: string;
	/** English name, offered as a designation. */
	en: string;
	/** 0 = chapter, 1 = component/range, 2 = the codes themselves. */
	level: number;
	chapter: string | null;
	active: boolean;
	inclusion?: string;
	exclusion?: string;
	/** ICD-10 main reference, where the Directorate's notes name one. */
	icd10?: string;
}

interface Table {
	source: string;
	fetched: string;
	codes: Icpc2Code[];
}

const data = table as Table;
const byCode = new Map<string, Icpc2Code>(data.codes.map((c) => [c.code, c]));
const codes = data.codes.filter((c) => c.level === 2);

export const ICPC2 = {
	url: SYSTEM.ICPC2,
	version: data.fetched,
	title: 'ICPC-2 (norsk utgave)',
	source: data.source,
	count: codes.length
} as const;

/** The code, or null. Case and surrounding whitespace do not matter. */
export function lookupIcpc2(code: string): Icpc2Code | null {
	return byCode.get(code.trim().toUpperCase()) ?? null;
}

/** True for a code a diagnosis can be filed under - not a chapter or a range. */
export function isIcpc2Code(code: string): boolean {
	const found = lookupIcpc2(code);
	return Boolean(found && found.level === 2 && found.active);
}

const smartSearch = createSmartSearch(data.codes);

/**
 * Finds codes for what a clinician typed, with why each one matched. Chapter and
 * range rows are left out: nothing is filed under them. See `icpc2-search.ts`.
 */
export function searchIcpc2WithReasons(query: string, limit = 20): SmartHit[] {
	return smartSearch(query, limit);
}

/** The same, for callers that only want the codes. */
export function searchIcpc2(query: string, limit = 20): Icpc2Code[] {
	return smartSearch(query, limit).map((hit) => hit.code);
}

/** The seventeen chapters, in order. */
export function icpc2Chapters(): Icpc2Code[] {
	return data.codes.filter((c) => c.level === 0);
}
