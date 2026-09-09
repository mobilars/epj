import { all, get } from '../db';
import { FhirError } from './outcome';
import { normaliserTekst, utvidDato, parseReferanse } from './indexing';
import { FELLES_PARAMS, paramDef, SEARCH_PARAMS, type SearchParamDef } from './searchparams';
import type { FhirResource } from './types';

const SAMMENLIKNERE = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'] as const;
type Sammenlikner = (typeof SAMMENLIKNERE)[number];

export const MAKS_COUNT = 200;
export const STANDARD_COUNT = 20;

export interface SokeResultat {
	total: number;
	treff: FhirResource[];
	inkluderte: FhirResource[];
	offset: number;
	count: number;
}

interface Vilkar {
	sql: string;
	params: unknown[];
}

/** Ett `name=value`-uttrykk; flere verdier med komma er ELLER innen samme vilkår. */
function bygVilkar(
	resourceType: string,
	navn: string,
	modifier: string | undefined,
	raverdier: string[],
	def: SearchParamDef
): Vilkar {
	const eksisterer = (innerSql: string, params: unknown[]): Vilkar => ({
		sql: `EXISTS (SELECT 1 FROM search_index si WHERE si.resource_type = r.resource_type AND si.resource_id = r.id AND si.param = ? AND (${innerSql}))`,
		params: [navn, ...params]
	});

	if (modifier === 'missing') {
		const mangler = raverdier[0] === 'true';
		const inner = `SELECT 1 FROM search_index si WHERE si.resource_type = r.resource_type AND si.resource_id = r.id AND si.param = ?`;
		return { sql: `${mangler ? 'NOT EXISTS' : 'EXISTS'} (${inner})`, params: [navn] };
	}

	const orDeler: string[] = [];
	const params: unknown[] = [];

	for (const rå of raverdier) {
		switch (def.kind) {
			case 'string': {
				const v = normaliserTekst(rå);
				if (modifier === 'exact') {
					orDeler.push('si.value_string = ?');
					params.push(normaliserTekst(rå));
				} else if (modifier === 'contains') {
					orDeler.push("si.value_string LIKE ? ESCAPE '\\'");
					params.push(`%${likeEscape(v)}%`);
				} else {
					orDeler.push("si.value_string LIKE ? ESCAPE '\\'");
					params.push(`${likeEscape(v)}%`);
				}
				break;
			}
			case 'uri': {
				if (modifier === 'below') {
					orDeler.push("si.value_string LIKE ? ESCAPE '\\'");
					params.push(`${likeEscape(rå)}%`);
				} else {
					orDeler.push('si.value_string = ?');
					params.push(rå);
				}
				break;
			}
			case 'token': {
				const { system, kode } = splittToken(rå);
				if (modifier === 'text') {
					orDeler.push("si.value_string LIKE ? ESCAPE '\\'");
					params.push(`%${likeEscape(normaliserTekst(rå))}%`);
				} else if (system === null) {
					orDeler.push('si.token_code = ?');
					params.push(kode);
				} else if (kode === null) {
					orDeler.push('si.token_system = ?');
					params.push(system);
				} else if (system === '') {
					orDeler.push('si.token_code = ? AND si.token_system IS NULL');
					params.push(kode);
				} else {
					orDeler.push('si.token_system = ? AND si.token_code = ?');
					params.push(system, kode);
				}
				break;
			}
			case 'reference': {
				const ref = parseReferanse(rå);
				if (!ref) break;
				if (ref.type) {
					orDeler.push('si.ref_type = ? AND si.ref_id = ?');
					params.push(ref.type, ref.id);
				} else {
					orDeler.push('si.ref_id = ?');
					params.push(ref.id);
				}
				break;
			}
			case 'date': {
				const { sammenlikner, verdi } = splittSammenlikner(rå);
				const lav = utvidDato(verdi, 'lav');
				const hoy = utvidDato(verdi, 'hoy');
				if (!lav || !hoy) throw FhirError.ugyldig(`Ugyldig datoverdi for ${navn}: ${rå}`);
				orDeler.push(datoUttrykk(sammenlikner));
				params.push(...datoParams(sammenlikner, lav, hoy));
				break;
			}
			case 'number':
			case 'quantity': {
				const { sammenlikner, verdi } = splittSammenlikner(rå);
				const [tallDel, system, kode] = verdi.split('|');
				const tall = Number(tallDel);
				if (!Number.isFinite(tall)) throw FhirError.ugyldig(`Ugyldig tallverdi for ${navn}: ${rå}`);
				orDeler.push(tallUttrykk(sammenlikner) + (kode ? ' AND si.token_code = ?' : '') + (system ? ' AND si.token_system = ?' : ''));
				params.push(tall);
				if (kode) params.push(kode);
				if (system) params.push(system);
				break;
			}
		}
	}

	if (orDeler.length === 0) throw FhirError.ugyldig(`Ugyldig verdi for søkeparameter ${navn}`);
	const inner = orDeler.map((d) => `(${d})`).join(' OR ');
	const vilkar = eksisterer(inner, params);
	if (modifier === 'not') {
		return { sql: `NOT ${vilkar.sql}`, params: vilkar.params };
	}
	return vilkar;
}

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

function splittToken(rå: string): { system: string | null; kode: string | null } {
	if (!rå.includes('|')) return { system: null, kode: rå };
	const [system, kode] = rå.split('|');
	return { system, kode: kode === '' ? null : kode };
}

function splittSammenlikner(rå: string): { sammenlikner: Sammenlikner; verdi: string } {
	const prefiks = rå.slice(0, 2) as Sammenlikner;
	if (SAMMENLIKNERE.includes(prefiks)) return { sammenlikner: prefiks, verdi: rå.slice(2) };
	return { sammenlikner: 'eq', verdi: rå };
}

function datoUttrykk(s: Sammenlikner): string {
	switch (s) {
		case 'eq': return 'si.date_low >= ? AND si.date_high <= ?';
		case 'ne': return 'NOT (si.date_low >= ? AND si.date_high <= ?)';
		case 'gt': return 'si.date_high > ?';
		case 'ge': return 'si.date_high >= ?';
		case 'lt': return 'si.date_low < ?';
		case 'le': return 'si.date_low <= ?';
		case 'sa': return 'si.date_low > ?';
		case 'eb': return 'si.date_high < ?';
		case 'ap': return 'si.date_low <= ? AND si.date_high >= ?';
	}
}

function datoParams(s: Sammenlikner, lav: string, hoy: string): string[] {
	switch (s) {
		case 'eq': case 'ne': return [lav, hoy];
		case 'gt': case 'sa': return [hoy];
		case 'ge': return [lav];
		case 'lt': case 'eb': return [lav];
		case 'le': return [hoy];
		case 'ap': return [utvidApp(hoy, 1), utvidApp(lav, -1)];
	}
}

/** `ap` (approximately) tolkes som +/- 10 % av avstanden, minimum ett døgn. */
function utvidApp(iso: string, retning: 1 | -1): string {
	return new Date(new Date(iso).getTime() + retning * 24 * 3600 * 1000).toISOString();
}

function tallUttrykk(s: Sammenlikner): string {
	switch (s) {
		case 'eq': return 'si.num_low = ?';
		case 'ne': return 'si.num_low <> ?';
		case 'gt': case 'sa': return 'si.num_low > ?';
		case 'ge': return 'si.num_low >= ?';
		case 'lt': case 'eb': return 'si.num_low < ?';
		case 'le': return 'si.num_low <= ?';
		case 'ap': return 'ABS(si.num_low - ?) <= 0.1 * ABS(?)';
	}
}

export interface SokeOpsjoner {
	/** Ekstra vilkår fra tilgangskontrollen, f.eks. avgrensning til gitte pasienter. */
	tvangsfilter?: Vilkar[];
	/** Hard øvre grense uavhengig av `_count`. */
	maksCount?: number;
}

/**
 * Kjører et FHIR-søk. Alle parametre bindes; ingen brukerinput settes inn i SQL
 * som tekst.
 */
export function sok(
	resourceType: string,
	query: URLSearchParams,
	opsjoner: SokeOpsjoner = {}
): SokeResultat {
	if (!SEARCH_PARAMS[resourceType]) {
		throw FhirError.ikkeStottet(`Ressurstypen ${resourceType} støttes ikke`);
	}

	const vilkar: Vilkar[] = [{ sql: 'r.resource_type = ?', params: [resourceType] }, { sql: 'r.deleted = 0', params: [] }];
	vilkar.push(...(opsjoner.tvangsfilter ?? []));

	let count = STANDARD_COUNT;
	let offset = 0;
	let sortering: { param: string; retning: 'ASC' | 'DESC' }[] = [];
	const include: string[] = [];
	const revinclude: string[] = [];
	let summary = false;
	let elements: string[] | null = null;

	for (const [nokkel, verdi] of query) {
		if (nokkel === '_count') {
			const n = Number.parseInt(verdi, 10);
			if (Number.isFinite(n)) count = Math.max(0, Math.min(n, opsjoner.maksCount ?? MAKS_COUNT));
			continue;
		}
		if (nokkel === '_offset' || nokkel === '_getpagesoffset') {
			const n = Number.parseInt(verdi, 10);
			if (Number.isFinite(n)) offset = Math.max(0, n);
			continue;
		}
		if (nokkel === '_sort') {
			sortering = verdi.split(',').filter(Boolean).map((s) =>
				s.startsWith('-') ? { param: s.slice(1), retning: 'DESC' as const } : { param: s, retning: 'ASC' as const }
			);
			continue;
		}
		if (nokkel === '_include') { include.push(verdi); continue; }
		if (nokkel === '_revinclude') { revinclude.push(verdi); continue; }
		if (nokkel === '_summary') { summary = verdi !== 'false'; continue; }
		if (nokkel === '_elements') { elements = verdi.split(',').filter(Boolean); continue; }
		if (nokkel === '_total' || nokkel === '_format' || nokkel === '_pretty') continue;
		if (nokkel.startsWith('_has:')) {
			vilkar.push(hasVilkar(nokkel, verdi));
			continue;
		}

		const [navnDel, modifier] = nokkel.split(':');
		if (navnDel.includes('.')) {
			vilkar.push(kjedetVilkar(resourceType, navnDel, verdi));
			continue;
		}
		const def = paramDef(resourceType, navnDel);
		if (!def) {
			throw FhirError.ugyldig(`Ukjent søkeparameter «${navnDel}» for ${resourceType}`);
		}
		const verdier = query.getAll(nokkel);
		if (verdier[0] !== verdi) continue; // allerede behandlet (getAll returnerer alle)
		// Flere forekomster av samme parameter = OG. Komma innen én verdi = ELLER.
		for (const v of verdier) {
			vilkar.push(bygVilkar(resourceType, navnDel, modifier, splittKomma(v), def));
		}
	}

	const where = vilkar.map((v) => `(${v.sql})`).join(' AND ');
	const params = vilkar.flatMap((v) => v.params);

	const totalRad = get<{ n: number }>(`SELECT COUNT(*) AS n FROM resource r WHERE ${where}`, ...params);
	const total = totalRad?.n ?? 0;

	const orderBy = byggSortering(resourceType, sortering);
	const rader = count === 0 ? [] : all<{ content: string }>(
		`SELECT r.content FROM resource r WHERE ${where} ${orderBy} LIMIT ? OFFSET ?`,
		...params, count, offset
	);
	let treff = rader.map((r) => JSON.parse(r.content) as FhirResource);
	if (elements) treff = treff.map((r) => begrensElementer(r, elements!));
	else if (summary) treff = treff.map((r) => begrensElementer(r, SUMMARY_ELEMENTER));

	const inkluderte = hentInkluderte(treff, include, revinclude);
	return { total, treff, inkluderte, offset, count };
}

function splittKomma(v: string): string[] {
	// Komma innen en verdi kan escapes med \,
	return v.split(/(?<!\\),/).map((s) => s.replace(/\\,/g, ','));
}

function byggSortering(resourceType: string, sortering: { param: string; retning: 'ASC' | 'DESC' }[]): string {
	if (sortering.length === 0) return 'ORDER BY r.last_updated DESC, r.id';
	const deler: string[] = [];
	for (const s of sortering) {
		if (s.param === '_lastUpdated') { deler.push(`r.last_updated ${s.retning}`); continue; }
		if (s.param === '_id') { deler.push(`r.id ${s.retning}`); continue; }
		const def = paramDef(resourceType, s.param);
		if (!def) throw FhirError.ugyldig(`Kan ikke sortere på ukjent parameter «${s.param}»`);
		const kolonne = def.kind === 'date' ? 'date_low' : def.kind === 'number' || def.kind === 'quantity' ? 'num_low' : 'value_string';
		// Korrelert delspørring; parameternavnet er validert mot registeret over.
		deler.push(
			`(SELECT MIN(si.${kolonne}) FROM search_index si WHERE si.resource_type = r.resource_type AND si.resource_id = r.id AND si.param = '${s.param.replace(/'/g, "''")}') ${s.retning}`
		);
	}
	return `ORDER BY ${deler.join(', ')}, r.id`;
}

/** `_has:Observation:patient:code=1234` - omvendt kjeding. */
function hasVilkar(nokkel: string, verdi: string): Vilkar {
	const [, målType, refParam, sokeParam] = nokkel.split(':');
	if (!målType || !refParam || !sokeParam) throw FhirError.ugyldig(`Ugyldig _has-uttrykk: ${nokkel}`);
	const refDef = paramDef(målType, refParam);
	const sokDef = paramDef(målType, sokeParam);
	if (!refDef || !sokDef) throw FhirError.ugyldig(`Ukjent parameter i _has-uttrykk: ${nokkel}`);
	const indre = bygVilkar(målType, sokeParam, undefined, splittKomma(verdi), sokDef);
	return {
		sql: `EXISTS (SELECT 1 FROM resource r2 JOIN search_index sref ON sref.resource_type = r2.resource_type AND sref.resource_id = r2.id
			WHERE r2.resource_type = ? AND r2.deleted = 0 AND sref.param = ? AND sref.ref_id = r.id
			AND ${indre.sql.replace(/\br\.resource_type\b/g, 'r2.resource_type').replace(/\br\.id\b/g, 'r2.id')})`,
		params: [målType, refParam, ...indre.params]
	};
}

/** `subject.name=Hansen` - kjedet søk ett nivå. */
function kjedetVilkar(resourceType: string, navnDel: string, verdi: string): Vilkar {
	const [refParam, ...rest] = navnDel.split('.');
	const [refNavn, typeHint] = refParam.split(':');
	const refDef = paramDef(resourceType, refNavn);
	if (!refDef || refDef.kind !== 'reference') throw FhirError.ugyldig(`«${refNavn}» er ikke en referanseparameter`);
	const målTyper = typeHint ? [typeHint] : (refDef.targets ?? []);
	if (målTyper.length === 0) throw FhirError.ugyldig(`Kjedet søk krever måltype for «${refNavn}»`);
	const restNavn = rest.join('.');
	const [målParamNavn, målModifier] = restNavn.split(':');

	const orDeler: string[] = [];
	const params: unknown[] = [];
	for (const målType of målTyper) {
		const målDef = paramDef(målType, målParamNavn);
		if (!målDef) continue;
		const indre = bygVilkar(målType, målParamNavn, målModifier, splittKomma(verdi), målDef);
		orDeler.push(
			`EXISTS (SELECT 1 FROM resource r2 WHERE r2.resource_type = ? AND r2.deleted = 0 AND r2.id = sref.ref_id
				AND ${indre.sql.replace(/\br\.resource_type\b/g, 'r2.resource_type').replace(/\br\.id\b/g, 'r2.id')})`
		);
		params.push(målType, ...indre.params);
	}
	if (orDeler.length === 0) throw FhirError.ugyldig(`Ukjent kjedet parameter «${navnDel}»`);
	return {
		sql: `EXISTS (SELECT 1 FROM search_index sref WHERE sref.resource_type = r.resource_type AND sref.resource_id = r.id
			AND sref.param = ? AND (${orDeler.join(' OR ')}))`,
		params: [refNavn, ...params]
	};
}

const SUMMARY_ELEMENTER = [
	'resourceType', 'id', 'meta', 'identifier', 'status', 'code', 'subject', 'patient',
	'name', 'birthDate', 'gender', 'active', 'date', 'effectiveDateTime', 'authoredOn', 'category'
];

function begrensElementer(r: FhirResource, elementer: string[]): FhirResource {
	const beholdt: FhirResource = { resourceType: r.resourceType, id: r.id, meta: r.meta };
	for (const e of elementer) {
		if (e in r) (beholdt as Record<string, unknown>)[e] = r[e];
	}
	beholdt.meta = { ...(r.meta ?? {}), tag: [...(r.meta?.tag ?? []), { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED' }] };
	return beholdt;
}

function hentInkluderte(treff: FhirResource[], include: string[], revinclude: string[]): FhirResource[] {
	const resultat = new Map<string, FhirResource>();
	const nokkel = (r: FhirResource) => `${r.resourceType}/${r.id}`;
	const alleredeMed = new Set(treff.map(nokkel));

	for (const spec of include) {
		const [kildeType, paramNavn, målTypeHint] = spec.split(':');
		for (const r of treff) {
			if (r.resourceType !== kildeType && kildeType !== '*') continue;
			const def = paramDef(r.resourceType, paramNavn);
			if (!def || def.kind !== 'reference') continue;
			const rader = all<{ ref_type: string | null; ref_id: string }>(
				'SELECT ref_type, ref_id FROM search_index WHERE resource_type = ? AND resource_id = ? AND param = ?',
				r.resourceType, r.id ?? '', paramNavn
			);
			for (const rad of rader) {
				const type = rad.ref_type ?? målTypeHint;
				if (!type) continue;
				if (målTypeHint && type !== målTypeHint) continue;
				leggTil(type, rad.ref_id);
			}
		}
	}

	for (const spec of revinclude) {
		const [kildeType, paramNavn] = spec.split(':');
		for (const r of treff) {
			const rader = all<{ content: string; resource_type: string; id: string }>(
				`SELECT r2.content, r2.resource_type, r2.id FROM resource r2
				 JOIN search_index si ON si.resource_type = r2.resource_type AND si.resource_id = r2.id
				 WHERE r2.resource_type = ? AND r2.deleted = 0 AND si.param = ? AND si.ref_id = ? LIMIT 200`,
				kildeType, paramNavn, r.id ?? ''
			);
			for (const rad of rader) {
				const k = `${rad.resource_type}/${rad.id}`;
				if (alleredeMed.has(k) || resultat.has(k)) continue;
				resultat.set(k, JSON.parse(rad.content) as FhirResource);
			}
		}
	}

	function leggTil(type: string, id: string) {
		const k = `${type}/${id}`;
		if (alleredeMed.has(k) || resultat.has(k)) return;
		const rad = get<{ content: string }>(
			'SELECT content FROM resource WHERE resource_type = ? AND id = ? AND deleted = 0', type, id
		);
		if (rad) resultat.set(k, JSON.parse(rad.content) as FhirResource);
	}

	return [...resultat.values()];
}

export { FELLES_PARAMS };
