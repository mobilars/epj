import type { Icpc2Code } from './icpc2';

/**
 * Finding the ICPC-2 code for what a clinician actually types.
 *
 * The official names are often not the words used in a consultation: nobody
 * says "Cystitt/urinveisinfeksjon IKA", they say "uvi". So a search looks in
 * four places, in this order of trust:
 *
 * - everyday words, a short list kept by hand (`EVERYDAY_TERMS`)
 * - the official name
 * - the Directorate's own pointers: under R74 the table says "bihulebetennelse
 *   R75", which is the Directorate saying that word belongs to R75
 * - the inclusion notes
 *
 * An exclusion note never counts for the code it sits on. It means "not this
 * code", and matching it would suggest exactly what the table rules out.
 *
 * It tolerates what happens at a keyboard: inflected words ("ryggen"), missing
 * Norwegian letters ("hoyt blodtrykk") and, when nothing else matched, typos.
 * It only ever suggests. The clinician picks, and everything runs on this server,
 * so nothing typed leaves the record.
 */

/**
 * Words used in practice, each with the codes it most often means, most likely
 * first. These are suggestions, not clinical rules, and should be reviewed by a
 * clinician. A test checks that every code exists.
 */
export const EVERYDAY_TERMS: Record<string, string[]> = {
	'høyt blodtrykk': ['K86', 'K85'],
	sukkersyke: ['T90', 'T89'],
	kols: ['R95'],
	uvi: ['U71'],
	blærekatarr: ['U71'],
	pneumoni: ['R81'],
	halsbetennelse: ['R76', 'R74'],
	'vondt i halsen': ['R21', 'R76'],
	'sår hals': ['R21', 'R76'],
	ørebetennelse: ['H71'],
	slag: ['K90'],
	ryggsmerter: ['L03', 'L02'],
	'vondt i ryggen': ['L03', 'L02'],
	korsryggsmerter: ['L03'],
	lumbago: ['L03', 'L84'],
	isjias: ['L86'],
	nakkesmerter: ['L01', 'L83'],
	'vondt i nakken': ['L01', 'L83'],
	magesmerter: ['D01', 'D06'],
	'vondt i magen': ['D01', 'D06'],
	omgangssyke: ['D70'],
	gastroenteritt: ['D70'],
	'sure oppstøt': ['D03', 'D84'],
	tungpust: ['R02'],
	pustevansker: ['R02'],
	sliten: ['A04'],
	trøtt: ['A04'],
	utmattet: ['A04'],
	nedstemt: ['P03', 'P76'],
	depresjon: ['P76', 'P03'],
	angst: ['P74'],
	søvnløshet: ['P06'],
	insomni: ['P06'],
	'sover dårlig': ['P06'],
	'høyt kolesterol': ['T93'],
	kolesterol: ['T93'],
	'lavt stoffskifte': ['T86'],
	'høyt stoffskifte': ['T85'],
	slitasjegikt: ['L91', 'L90'],
	gikt: ['T92', 'L91'],
	eksem: ['S87', 'S88'],
	kviser: ['S96'],
	fotsopp: ['S74'],
	soppinfeksjon: ['S74', 'S75'],
	gravid: ['W78'],
	graviditet: ['W78'],
	'p-piller': ['W11'],
	hjerteflimmer: ['K78'],
	flimmer: ['K78'],
	angina: ['K74'],
	øyekatarr: ['F70'],
	høysnue: ['R97'],
	pollenallergi: ['R97'],
	alzheimer: ['P70'],
	svimmel: ['N17'],
	jernmangel: ['B80'],
	blodmangel: ['B80'],
	kyssesyke: ['A75'],
	røyking: ['P17'],
	// The table says "ondartet svulst". Without these, "kreft" finds the codes for
	// being afraid of cancer, which are the only names that use the word.
	kreft: ['A79', 'R84', 'D75', 'X76', 'Y77', 'S77'],
	brystkreft: ['X76'],
	lungekreft: ['R84'],
	tarmkreft: ['D75'],
	tykktarmskreft: ['D75'],
	magekreft: ['D74'],
	bukspyttkjertelkreft: ['D76'],
	prostatakreft: ['Y77'],
	hudkreft: ['S77'],
	føflekkreft: ['S77'],
	livmorhalskreft: ['X75'],
	nyrekreft: ['U75'],
	blærekreft: ['U76'],
	blodkreft: ['B73'],
	lymfekreft: ['B72'],
	korona: ['R991', 'R992'],
	adhd: ['P81'],
	add: ['P81'],
	overgangsalder: ['X11'],
	vannlatingsplager: ['U05'],
	'vondt i hodet': ['N01'],
	'vondt i øret': ['H01'],
	ørevondt: ['H01'],
	'vondt i brystet': ['A11'],
	glemsom: ['P20'],
	attest: ['A97'],
	førerkort: ['A97']
};

/** Says nothing about which code is meant, so it can go unmatched. */
const SOFT_WORDS = new Set(['vondt', 'smerte', 'smerter', 'plage', 'plager', 'problem', 'problemer', 'sar', 'symptom', 'symptomer']);
const STOP_WORDS = new Set(['i', 'og', 'med', 'av', 'pa', 'for', 'ved', 'til', 'en', 'et', 'ei', 'har', 'er', 'den', 'det']);

/** Norwegian word endings, for matching "ryggen" to "rygg". */
const INFLECTIONS = new Set(['e', 'n', 't', 'r', 'a', 'en', 'et', 'er', 'ar', 'ene', 'ane']);

const MAX_RESULTS = 20;

/** Lower case, and Norwegian letters written the way a keyboard without them does. */
export function foldText(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFC')
		.replace(/æ/g, 'ae')
		.replace(/[øö]/g, 'o')
		.replace(/[åä]/g, 'a');
}

const tokensOf = (text: string) => foldText(text).split(/[\s/,;:()\-.]+/).filter(Boolean);

/** Edit distance with transposition, giving up as soon as it passes `limit`. */
export function editDistance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let before = new Array<number>(b.length + 1).fill(0);
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				value = Math.min(value, before[j - 2] + 1);
			}
			current[j] = value;
			if (value < best) best = value;
		}
		if (best > limit) return limit + 1;
		before = previous;
		previous = current;
	}
	return previous[b.length];
}

interface Field {
	tokens: string[];
	weight: number;
	/** Shown to the clinician when this is what matched, and not the name. */
	via: string | null;
}

interface Entry {
	code: Icpc2Code;
	fields: Field[];
}

export interface SmartHit {
	code: Icpc2Code;
	/** Why it matched, when the name does not show it. */
	via: string | null;
}

/** `term CODE` pairs out of an exclusion note. */
export function exclusionPointers(exclusion: string): { term: string; code: string }[] {
	return [...exclusion.matchAll(/(.+?)\s([A-Z]\d\d)(?=\s|$)/g)].map((m) => ({ term: m[1].trim(), code: m[2] }));
}

/** How well one typed word matches one token. Zero when it does not. */
function wordScore(word: string, token: string, typos: boolean): number {
	if (token === word) return 4;
	if (word.length >= 2 && token.startsWith(word)) return 3;
	// An inflected form of the token: "ryggen", "smerter", "kneet". Only real
	// endings count: "hoste" is not "hos" with something on the end.
	if (token.length >= 3 && word.startsWith(token) && INFLECTIONS.has(word.slice(token.length))) return 2.5;
	// Part of a compound: "betennelse" in "halsbetennelse".
	if (word.length >= 4 && token.includes(word)) return 2;
	if (typos && word.length >= 4 && word[0] === token[0]) {
		if (editDistance(word, token, word.length >= 8 ? 2 : 1) <= (word.length >= 8 ? 2 : 1)) return 1.5;
	}
	return 0;
}

export function createSmartSearch(all: Icpc2Code[]) {
	const codes = all.filter((c) => c.level === 2 && c.active);
	const byCode = new Map(codes.map((c) => [c.code, c]));
	const entries = new Map<string, Entry>(
		codes.map((code) => [
			code.code,
			{
				code,
				fields: [
					{ tokens: tokensOf(code.display), weight: 1, via: null },
					{ tokens: tokensOf(code.inclusion ?? ''), weight: 0.6, via: null }
				]
			}
		])
	);

	// The Directorate's pointers, filed under the code they point at.
	for (const source of codes) {
		for (const { term, code } of exclusionPointers(source.exclusion ?? '')) {
			entries.get(code)?.fields.push({ tokens: tokensOf(term), weight: 0.85, via: term });
		}
	}
	for (const [term, targets] of Object.entries(EVERYDAY_TERMS)) {
		for (const code of targets) entries.get(code)?.fields.push({ tokens: tokensOf(term), weight: 1.1, via: term });
	}

	const everyday = new Map(Object.entries(EVERYDAY_TERMS).map(([term, targets]) => [tokensOf(term).join(' '), targets]));
	const common = new Set(Object.values(EVERYDAY_TERMS).flat());

	function score(entry: Entry, words: string[], typos: boolean): { total: number; via: string | null } | null {
		let total = 0;
		let via: string | null = null;
		let matched = 0;
		for (const word of words) {
			let best = 0;
			let bestVia: string | null = null;
			for (const field of entry.fields) {
				for (const token of field.tokens) {
					const value = wordScore(word, token, typos) * field.weight;
					if (value > best) {
						best = value;
						bestVia = field.via;
					}
				}
			}
			if (best > 0) {
				matched++;
				total += best;
				via ??= bestVia;
			} else if (!SOFT_WORDS.has(word)) {
				return null;
			}
		}
		return matched ? { total, via } : null;
	}

	function byWords(words: string[], typos: boolean): SmartHit[] {
		const hits: { hit: SmartHit; total: number }[] = [];
		for (const entry of entries.values()) {
			const result = score(entry, words, typos);
			if (result) {
				hits.push({
					hit: { code: entry.code, via: result.via },
					total: result.total + (common.has(entry.code.code) ? 0.2 : 0)
				});
			}
		}
		return hits
			.sort((a, b) => b.total - a.total || a.hit.code.code.localeCompare(b.hit.code.code))
			.map((h) => h.hit);
	}

	/** A code, a start of one, or an ICD-10 code that the table refers to. */
	function byCodes(query: string): SmartHit[] {
		const typed = query.toUpperCase().replace(/\s+/g, '');
		if (!/^[A-Z]\d{0,2}(\.\d*)?$/.test(typed)) return [];
		const hits: SmartHit[] = typed.includes('.') ? [] : codes.filter((c) => c.code.startsWith(typed)).map((code) => ({ code, via: null }));
		if (typed.length >= 3) {
			for (const code of codes) {
				if (code.icd10?.startsWith(typed) && !hits.some((h) => h.code === code)) {
					hits.push({ code, via: `ICD-10 ${code.icd10}` });
				}
			}
		}
		return hits;
	}

	return function search(query: string, limit = MAX_RESULTS): SmartHit[] {
		const trimmed = query.trim();
		if (!trimmed) return [];

		const coded = byCodes(trimmed);
		if (coded.length) return coded.slice(0, limit);

		const tokens = tokensOf(trimmed);
		const words = tokens.filter((t) => !STOP_WORDS.has(t));
		if (!words.length) return [];

		// A phrase that is one of the everyday terms goes first, in the order listed.
		const phrase = tokens.join(' ');
		const direct: SmartHit[] = (everyday.get(phrase) ?? [])
			.map((code) => byCode.get(code))
			.filter((code): code is Icpc2Code => Boolean(code))
			.map((code) => ({ code, via: trimmed }));

		// Typos only when nothing matched as written. Otherwise "hoste" would also
		// find everything spelled nearly like it, and be worse for the common case.
		const found = byWords(words, false);
		const ranked = found.length ? found : byWords(words, true);

		const seen = new Set(direct.map((h) => h.code.code));
		return [...direct, ...ranked.filter((h) => !seen.has(h.code.code))].slice(0, limit);
	};
}
