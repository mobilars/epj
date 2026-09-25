import type { AuthContext } from '../authz/context';
import { resources, searchResources } from '../fhir/internal';
import type { FhirResource } from '../fhir/types';

/**
 * Text search in a patient's record notes.
 *
 * HAPI can search text with `_content`, but only with a full-text index it is
 * not running here, and an index of clinical free text is a copy of the record
 * that would need the same protection as the record itself. The notes are
 * therefore fetched through the ordinary gateway - with its access checks and
 * its audit trail - and searched in memory, one patient at a time. A GP
 * patient's notes run to hundreds, not millions, and that is the only scale this
 * has to handle.
 *
 * Every term must be present somewhere in the note (title, author or any
 * section). Case is ignored; nothing else is normalised, because a search that
 * quietly matches something other than what was typed is worse than one that
 * misses.
 */

/** HAPI's `max_page_size` in the manifests. Asking for more gets this anyway. */
const PAGE = 200;

/** How many notes a search will read before it stops and says so. */
export const SEARCH_LIMIT = 2000;

/** At most this many terms, so a pasted paragraph is not a query plan. */
const MAX_TERMS = 8;

export interface Segment {
	text: string;
	hit: boolean;
}

/** The query split into lower-case terms, duplicates and blanks removed. */
export function searchTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** True when every term occurs in the text. */
export function matchesAll(text: string, terms: string[]): boolean {
	const lower = text.toLowerCase();
	return terms.every((t) => lower.includes(t));
}

/**
 * The text cut into runs that did and did not match, for marking up the hits.
 *
 * Returned as data rather than HTML so the page renders it with ordinary text
 * interpolation: clinical free text never goes near `{@html}`.
 */
export function highlight(text: string, terms: string[]): Segment[] {
	if (!text || terms.length === 0) return text ? [{ text, hit: false }] : [];
	const lower = text.toLowerCase();
	// Lower-casing can change the length of a string in a handful of scripts,
	// and then an index in one is not an index in the other. Norwegian is not
	// one of them, but the note could quote something that is: show it unmarked
	// rather than mark the wrong characters.
	if (lower.length !== text.length) return [{ text, hit: false }];

	const ranges: [number, number][] = [];
	for (const term of terms) {
		let from = 0;
		for (;;) {
			const at = lower.indexOf(term, from);
			if (at < 0) break;
			ranges.push([at, at + term.length]);
			from = at + term.length;
		}
	}
	if (ranges.length === 0) return [{ text, hit: false }];

	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}

	const out: Segment[] = [];
	let pos = 0;
	for (const [start, end] of merged) {
		if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
		out.push({ text: text.slice(start, end), hit: true });
		pos = end;
	}
	if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
	return out;
}

/**
 * Every note for the patient, newest first, up to `limit`.
 *
 * Pages by date rather than by HAPI's paging links: those point straight at
 * HAPI, past the gateway, and a search result must never be something the
 * access checks did not see. Each page asks for notes at or before the oldest
 * one already seen; the overlap at the boundary is dropped by id. A page that
 * brings nothing new ends the walk, so a run of notes sharing one timestamp
 * cannot loop it.
 */
export async function allNotes(
	ctx: AuthContext,
	patientId: string,
	limit = SEARCH_LIMIT
): Promise<{ notes: FhirResource[]; truncated: boolean }> {
	const seen = new Set<string>();
	const notes: FhirResource[] = [];
	let before: string | null = null;

	while (notes.length < limit) {
		const bundle = await searchResources(ctx, 'Composition', {
			patient: `Patient/${patientId}`,
			_count: PAGE,
			_sort: '-date',
			date: before ? `le${before}` : undefined
		});
		const page = resources(bundle);
		let added = 0;
		for (const note of page) {
			const id = note.id as string | undefined;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			notes.push(note);
			added++;
			if (notes.length >= limit) break;
		}
		if (page.length < PAGE || added === 0) return { notes, truncated: false };
		const oldest = page[page.length - 1]?.date as string | undefined;
		if (!oldest) return { notes, truncated: false };
		before = oldest;
	}
	return { notes, truncated: true };
}
