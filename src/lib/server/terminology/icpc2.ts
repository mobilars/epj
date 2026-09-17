import table from './icpc2.json';
import { SYSTEM } from '../fhir/codesystems';

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

const fold = (s: string) => s.toLowerCase().normalize('NFC');

/**
 * Finds codes for what a clinician typed.
 *
 * A code prefix wins outright - `K8` lists K80 onwards - and then words. A
 * match at the start of the name ranks above one inside it, and one in the
 * name above one only in the inclusion notes, so "hypertensjon" gives K86
 * before the pregnancy code that merely mentions it. Chapter and range rows
 * are left out: nothing is filed under them.
 */
export function searchIcpc2(query: string, limit = 20): Icpc2Code[] {
	const q = fold(query.trim());
	if (!q) return [];

	if (/^[a-z]\d{0,2}$/i.test(q)) {
		const prefix = q.toUpperCase();
		return codes.filter((c) => c.active && c.code.startsWith(prefix)).slice(0, limit);
	}

	const words = q.split(/\s+/).filter(Boolean);
	const scored: { code: Icpc2Code; score: number }[] = [];
	for (const c of codes) {
		if (!c.active) continue;
		const name = fold(c.display);
		const notes = fold(c.inclusion ?? '');
		let score = 0;
		for (const w of words) {
			if (name.startsWith(w)) score += 3;
			else if (name.split(/[\s/,()-]+/).some((t) => t.startsWith(w))) score += 2;
			else if (name.includes(w)) score += 1;
			else if (notes.includes(w)) score += 0.5;
			else {
				score = 0;
				break;
			}
		}
		if (score > 0) scored.push({ code: c, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.code.code.localeCompare(b.code.code))
		.slice(0, limit)
		.map((s) => s.code);
}

/** The seventeen chapters, in order. */
export function icpc2Chapters(): Icpc2Code[] {
	return data.codes.filter((c) => c.level === 0);
}
