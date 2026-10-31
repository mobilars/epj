import { describe, expect, it } from 'vitest';
import { ICPC2, isIcpc2Code, lookupIcpc2, searchIcpc2, searchIcpc2WithReasons } from '../src/platform/server/terminology/icpc2';
import { EVERYDAY_TERMS, editDistance, exclusionPointers, foldText } from '../src/platform/server/terminology/icpc2-search';

const top = (query: string, n = 3) => searchIcpc2(query).slice(0, n).map((c) => c.code);

/**
 * Finding a code from what a clinician types.
 *
 * The cases are what a consultation sounds like. The right code has to be near
 * the top, because a code further down is a code nobody picks.
 */
describe('smart ICPC-2 search', () => {
	it.each([
		['høyt blodtrykk', 'K86'],
		['hypertensjon', 'K86'],
		['sukkersyke', 'T90'],
		['diabetes type 2', 'T90'],
		['kols', 'R95'],
		['uvi', 'U71'],
		['urinveisinfeksjon', 'U71'],
		['forkjølelse', 'R74'],
		['halsbetennelse', 'R76'],
		['bihulebetennelse', 'R75'],
		['lungebetennelse', 'R81'],
		['ryggsmerter', 'L03'],
		['vondt i ryggen', 'L03'],
		['isjias', 'L86'],
		['migrene', 'N89'],
		['depresjon', 'P76'],
		['angst', 'P74'],
		['søvnløshet', 'P06'],
		['høysnue', 'R97'],
		['atrieflimmer', 'K78'],
		['gravid', 'W78'],
		['slitasjegikt', 'L91'],
		['høyt kolesterol', 'T93'],
		['lavt stoffskifte', 'T86'],
		['brystkreft', 'X76'],
		['lungekreft', 'R84'],
		['korona', 'R991'],
		['adhd', 'P81'],
		['overgangsalder', 'X11'],
		['vannlatingsplager', 'U05'],
		['vondt i hodet', 'N01']
	])('finds %s near the top', (query, code) => {
		expect(top(query)).toContain(code);
	});

	it('puts cancer before the fear of it', () => {
		expect(top('kreft', 1)).toEqual(['A79']);
		expect(top('brystkreft', 1)).toEqual(['X76']);
	});

	it('puts covid before coronary disease for "korona"', () => {
		// K76 may follow: "korona" is also how "koronar" starts.
		expect(top('korona', 2)).toEqual(['R991', 'R992']);
	});

	it('does not read a word as a shorter word plus something that is no ending', () => {
		// "hoste" is not "hos" + "te": the codes "... hos barn" have nothing to do with it.
		const hits = searchIcpc2('hoste').map((c) => c.code);
		expect(hits[0]).toBe('R05');
		expect(hits).not.toContain('F80');
		expect(hits).not.toContain('P11');
	});

	it('copes with missing Norwegian letters', () => {
		expect(top('hoyt blodtrykk')).toContain('K86');
		expect(top('sovnloshet')).toContain('P06');
		expect(top('forkjolelse')).toContain('R74');
	});

	it('copes with inflected words', () => {
		expect(top('ryggen')).toContain('L02');
		expect(top('vondt i kneet')).toContain('L15');
		expect(top('smerter i hoften')).toContain('L13');
		expect(top('hodepinen')).toContain('N01');
	});

	it('copes with typos, but only when nothing matched as written', () => {
		expect(top('hypertensjn')).toContain('K86');
		expect(top('lungebetenelse')).toContain('R81');
		expect(top('migrne')).toContain('N89');
		// Spelled correctly, "hoste" must not also bring in near-spellings.
		expect(searchIcpc2('hoste').some((c) => /hode|hofte/i.test(c.display))).toBe(false);
	});

	it('uses the Directorate pointers: a term excluded elsewhere finds the code it points at', () => {
		// R74 excludes "bihulebetennelse R75", which is the Directorate placing the word.
		expect(exclusionPointers('allergisk rhinitt R97 bihulebetennelse R75')).toEqual([
			{ term: 'allergisk rhinitt', code: 'R97' },
			{ term: 'bihulebetennelse', code: 'R75' }
		]);
		expect(top('falsk krupp')).toContain('R77');
	});

	it('never matches a code on its own exclusion note', () => {
		// T90's note excludes "hyperglykemi som isolert funn", so that word must not find T90.
		expect(lookupIcpc2('T90')?.exclusion).toMatch(/hyperglykemi/);
		expect(lookupIcpc2('T90')?.inclusion ?? '').not.toMatch(/hyperglykemi/);
		expect(searchIcpc2('hyperglykemi').map((c) => c.code)).not.toContain('T90');
	});

	it('says why a code came up when its name does not', () => {
		const [hit] = searchIcpc2WithReasons('uvi');
		expect(hit.code.code).toBe('U71');
		expect(hit.via).toBe('uvi');
		const named = searchIcpc2WithReasons('migrene').find((h) => h.code.code === 'N89');
		expect(named?.via).toBeNull();
	});

	it('finds a code by the ICD-10 code the table refers to', () => {
		const [hit] = searchIcpc2WithReasons('I10');
		expect(hit.code.code).toBe('K86');
		expect(hit.via).toContain('ICD-10');
		expect(top('J06.9')).toContain('R74');
	});

	it('keeps code search as it was', () => {
		expect(top('K8', 3)).toEqual(['K80', 'K81', 'K82']);
		expect(top('k86', 1)).toEqual(['K86']);
		expect(top('K 86', 1)).toEqual(['K86']);
	});

	it('returns nothing for nothing, for filler, and for nonsense', () => {
		expect(searchIcpc2('')).toEqual([]);
		expect(searchIcpc2('   ')).toEqual([]);
		expect(searchIcpc2('i og med')).toEqual([]);
		expect(searchIcpc2('xyzzy')).toEqual([]);
	});

	it('does not match on a word that says nothing by itself, like "vondt" alone in a phrase with a real word missing', () => {
		expect(searchIcpc2('vondt xyzzy')).toEqual([]);
	});

	it('only ever offers codes a diagnosis can be filed under', () => {
		for (const query of ['smerte', 'infeksjon', 'kreft', 'K', 'uvi']) {
			for (const code of searchIcpc2(query)) expect(isIcpc2Code(code.code), code.code).toBe(true);
		}
		expect(searchIcpc2('betennelse', 500).length).toBeLessThan(ICPC2.count);
	});

	it('honours the limit', () => {
		expect(searchIcpc2('smerte', 5)).toHaveLength(5);
	});

	it('every everyday term points at codes that exist', () => {
		for (const [term, codes] of Object.entries(EVERYDAY_TERMS)) {
			expect(codes.length, term).toBeGreaterThan(0);
			for (const code of codes) expect(isIcpc2Code(code), `${term} -> ${code}`).toBe(true);
		}
	});
});

describe('the text helpers', () => {
	it('folds Norwegian letters', () => {
		expect(foldText('Øre Bærum Åsane')).toBe('ore baerum asane');
	});

	it('measures edit distance, counting a swap as one', () => {
		expect(editDistance('migrene', 'migrene', 2)).toBe(0);
		expect(editDistance('migrne', 'migrene', 2)).toBe(1);
		expect(editDistance('migrnee', 'migrene', 2)).toBe(1);
		expect(editDistance('abc', 'xyz', 1)).toBeGreaterThan(1);
	});
});
