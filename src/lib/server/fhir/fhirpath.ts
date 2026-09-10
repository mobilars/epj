/**
 * Hjelpefunksjoner for å navigere i FHIR-ressurser.
 *
 * Selve indekseringen og søket utføres av HAPI FHIR. Disse funksjonene brukes av
 * tilgangskontrollen og integrasjonene, som må kunne plukke ut pasientreferanser,
 * identifikatorer og datoer fra en ressurs uten å gå veien om serveren.
 */

/**
 * Normaliserer tekst for sammenlikning og søk.
 *
 * Unicode-dekomponering alene gir inkonsistent resultat på norsk: «å» brytes
 * opp i a + ring og mister ringen, mens «ø» og «æ» er egne bokstaver og blir
 * stående. Da ville «Håkon» matchet «Hakon», men «Søren» ikke «Soren». Vi
 * folder derfor de norske bokstavene eksplisitt først, slik at oppførselen er
 * den samme for alle tre.
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

/** Henter alle verdier på en punktseparert sti, og traverserer arrays underveis. */
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

/** Utvider en dato/periode til [lav, høy] i ISO-format for intervallsammenlikning. */
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
 * Tolker en FHIR-referanse. Håndterer relative referanser (`Patient/123`),
 * absolutte URL-er, `urn:uuid:`-referanser og versjonsspesifikke referanser
 * (`Observation/9/_history/2`), som skal gi ressursens id - ikke versjonen.
 */
export function parseReference(v: unknown): { type: string | null; id: string } | null {
	let ref: string | undefined;
	if (typeof v === 'string') ref = v;
	else if (isObj(v) && typeof v.reference === 'string') ref = v.reference;
	if (!ref) return null;
	if (ref.startsWith('urn:uuid:')) return { type: null, id: ref.slice('urn:uuid:'.length) };

	// Fjern versjonsdelen før vi plukker ut type og id.
	const withoutVersion = ref.split('/_history/')[0];
	const parts = withoutVersion.split('/').filter(Boolean);
	if (parts.length >= 2) {
		return { type: parts[parts.length - 2], id: parts[parts.length - 1] };
	}
	return { type: null, id: withoutVersion };
}
