import { describe, expect, it } from 'vitest';
import { highlight, matchesAll, searchTerms } from '../src/lib/server/journal/notesearch';

/**
 * Searching a patient's notes in memory.
 *
 * What matters: every term has to be present, case does not, and the marked-up
 * result must put back exactly the text it was given - a search that altered
 * the note it displayed would be a search that altered the record as read.
 */
describe('note search', () => {
	it('splits a query into lower-case terms, once each', () => {
		expect(searchTerms('  Hoste  FEBER hoste ')).toEqual(['hoste', 'feber']);
		expect(searchTerms('')).toEqual([]);
		expect(searchTerms('   ')).toEqual([]);
	});

	it('caps the number of terms', () => {
		expect(searchTerms('a b c d e f g h i j k').length).toBe(8);
	});

	it('requires every term, in any order and any case', () => {
		const note = 'Pasienten har hatt hoste i ti dager. Ingen feber.';
		expect(matchesAll(note, ['feber', 'hoste'])).toBe(true);
		expect(matchesAll(note, ['FEBER'.toLowerCase()])).toBe(true);
		expect(matchesAll(note, ['hoste', 'astma'])).toBe(false);
	});

	it('matches Norwegian letters', () => {
		expect(matchesAll('Øresmerter og sår hals', searchTerms('ØRESMERTER sår'))).toBe(true);
	});

	it('marks every occurrence and puts the text back exactly', () => {
		const text = 'Hoste. Mer hoste om natten.';
		const parts = highlight(text, ['hoste']);
		expect(parts.map((p) => p.text).join('')).toBe(text);
		expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Hoste', 'hoste']);
	});

	it('merges overlapping hits into one', () => {
		const parts = highlight('blodtrykk', ['blod', 'odtr']);
		expect(parts).toEqual([
			{ text: 'blodtr', hit: true },
			{ text: 'ykk', hit: false }
		]);
	});

	it('returns the text unmarked when nothing matches or there are no terms', () => {
		expect(highlight('Kontroll', ['feber'])).toEqual([{ text: 'Kontroll', hit: false }]);
		expect(highlight('Kontroll', [])).toEqual([{ text: 'Kontroll', hit: false }]);
		expect(highlight('', ['x'])).toEqual([]);
	});

	it('leaves text unmarked rather than mark the wrong characters when case-folding changes its length', () => {
		// "İ" lower-cases to two code units, which would shift every index after it.
		const text = 'İstanbul hoste';
		const parts = highlight(text, ['hoste']);
		expect(parts.map((p) => p.text).join('')).toBe(text);
	});
});
