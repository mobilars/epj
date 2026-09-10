/**
 * Helpers for navigating FHIR resources.
 *
 * The indexing and searching itself is done by HAPI FHIR. These functions are
 * used by access control and the integrations, which must be able to pick
 * patient references, identifiers and dates out of a resource without going via
 * the server.
 */
/**
 * Normalises text for comparison and search.
 *
 * Unicode decomposition alone gives inconsistent results in Norwegian: "å"
 * breaks into a + ring and loses the ring, while "ø" and "æ" are letters in
 * their own right and survive. "Håkon" would then match "Hakon", but "Søren"
 * would not match "Soren". So we fold the Norwegian letters explicitly first,
 * making the behaviour the same for all three.
 */
const NORWEGIAN_BOKSTAVER: Record<string, string> = { æ: 'ae', ø: 'o', å: 'a', Æ: 'ae', Ø: 'o', Å: 'a' };

export function normaliserText(v: string): string {
	return v
		.replace(/[æøåÆØÅ]/g, (t) => NORWEGIAN_BOKSTAVER[t])
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
}

/** Gets every value at a dot-separated path, traversing arrays on the way. */
export function getValues(objekt: unknown, path: string): unknown[] {
	let current: unknown[] = [objekt];
	for (const del of path.split('.')) {
		const next: unknown[] = [];
		for (const v of current) {
			if (v === null || typeof v !== 'object') continue;
			const children = (v as Record<string, unknown>)[del];
			if (children === undefined || children === null) continue;
			if (Array.isArray(children)) next.push(...children.filter((x) => x !== null && x !== undefined));
			else next.push(children);
		}
		current = next;
	}
	return current;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Expands a date/period to [low, high] in ISO form for interval comparison. */
export function dateIntervall(v: unknown): { lav: string; hoy: string } | null {
	if (typeof v === 'string') {
		const lav = utvidDate(v, 'lav');
		const hoy = utvidDate(v, 'hoy');
		return lav && hoy ? { lav, hoy } : null;
	}
	if (isObj(v)) {
		if ('start' in v || 'end' in v) {
			const lav = typeof v.start === 'string' ? utvidDate(v.start, 'lav') : '0000-01-01T00:00:00.000Z';
			const hoy = typeof v.end === 'string' ? utvidDate(v.end, 'hoy') : '9999-12-31T23:59:59.999Z';
			return lav && hoy ? { lav, hoy } : null;
		}
		if ('event' in v && Array.isArray(v.event) && typeof v.event[0] === 'string') {
			return dateIntervall(v.event[0]);
		}
	}
	return null;
}

/** «2024» -> 2024-01-01T00:00:00.000Z / 2024-12-31T23:59:59.999Z */
export function utvidDate(v: string, ende: 'lav' | 'hoy'): string | null {
	const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?/.exec(v);
	if (!m) return null;
	const [, year, mnd, dag, time, min, sek, ms] = m;
	if (ende === 'lav') {
		const d = Date.UTC(+year, mnd ? +mnd - 1 : 0, dag ? +dag : 1, time ? +time : 0, min ? +min : 0, sek ? +sek : 0, ms ? +ms.padEnd(3, '0') : 0);
		return new Date(d).toISOString();
	}
	const yearN = +year;
	const mndN = mnd ? +mnd - 1 : 11;
	const dagN = dag ? +dag : new Date(Date.UTC(yearN, mndN + 1, 0)).getUTCDate();
	const d = Date.UTC(yearN, mndN, dagN, time ? +time : 23, min ? +min : 59, sek ? +sek : 59, ms ? +ms.padEnd(3, '0') : 999);
	return new Date(d).toISOString();
}

/**
 * Parses a FHIR reference. Handles relative references (`Patient/123`),
 * absolute URLs, `urn:uuid:` references and version-specific references
 * (`Observation/9/_history/2`), which must yield the id - not the version.
 */
export function parseReference(v: unknown): { type: string | null; id: string } | null {
	let ref: string | undefined;
	if (typeof v === 'string') ref = v;
	else if (isObj(v) && typeof v.reference === 'string') ref = v.reference;
	if (!ref) return null;
	if (ref.startsWith('urn:uuid:')) return { type: null, id: ref.slice('urn:uuid:'.length) };

	// Strip the version part before picking out type and id.
	const withoutVersion = ref.split('/_history/')[0];
	const parts = withoutVersion.split('/').filter(Boolean);
	if (parts.length >= 2) {
		return { type: parts[parts.length - 2], id: parts[parts.length - 1] };
	}
	return { type: null, id: withoutVersion };
}
