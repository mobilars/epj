import { FELLES_PARAMS, SEARCH_PARAMS, type ParamKind, type SearchParamDef } from './searchparams';
import type { FhirResource } from './types';

export interface IndexRad {
	param: string;
	kind: ParamKind;
	value_string: string | null;
	token_system: string | null;
	token_code: string | null;
	ref_type: string | null;
	ref_id: string | null;
	num_low: number | null;
	num_high: number | null;
	date_low: string | null;
	date_high: string | null;
}

/** Normaliserer tekst for søk: små bokstaver, uten diakritiske tegn. */
export function normaliserTekst(v: string): string {
	return v
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
}

/** Henter alle verdier på en punktseparert sti, og traverserer arrays underveis. */
export function hentVerdier(objekt: unknown, sti: string): unknown[] {
	let gjeldende: unknown[] = [objekt];
	for (const del of sti.split('.')) {
		const neste: unknown[] = [];
		for (const v of gjeldende) {
			if (v === null || typeof v !== 'object') continue;
			const barn = (v as Record<string, unknown>)[del];
			if (barn === undefined || barn === null) continue;
			if (Array.isArray(barn)) neste.push(...barn.filter((x) => x !== null && x !== undefined));
			else neste.push(barn);
		}
		gjeldende = neste;
	}
	return gjeldende;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Utvider en dato/periode til [lav, høy] i ISO-format for intervallsammenlikning. */
export function datoIntervall(v: unknown): { lav: string; hoy: string } | null {
	if (typeof v === 'string') {
		const lav = utvidDato(v, 'lav');
		const hoy = utvidDato(v, 'hoy');
		return lav && hoy ? { lav, hoy } : null;
	}
	if (isObj(v)) {
		if ('start' in v || 'end' in v) {
			const lav = typeof v.start === 'string' ? utvidDato(v.start, 'lav') : '0000-01-01T00:00:00.000Z';
			const hoy = typeof v.end === 'string' ? utvidDato(v.end, 'hoy') : '9999-12-31T23:59:59.999Z';
			return lav && hoy ? { lav, hoy } : null;
		}
		if ('event' in v && Array.isArray(v.event) && typeof v.event[0] === 'string') {
			return datoIntervall(v.event[0]);
		}
	}
	return null;
}

/** «2024» -> 2024-01-01T00:00:00.000Z / 2024-12-31T23:59:59.999Z */
export function utvidDato(v: string, ende: 'lav' | 'hoy'): string | null {
	const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?/.exec(v);
	if (!m) return null;
	const [, aar, mnd, dag, time, min, sek, ms] = m;
	if (ende === 'lav') {
		const d = Date.UTC(+aar, mnd ? +mnd - 1 : 0, dag ? +dag : 1, time ? +time : 0, min ? +min : 0, sek ? +sek : 0, ms ? +ms.padEnd(3, '0') : 0);
		return new Date(d).toISOString();
	}
	const aarN = +aar;
	const mndN = mnd ? +mnd - 1 : 11;
	const dagN = dag ? +dag : new Date(Date.UTC(aarN, mndN + 1, 0)).getUTCDate();
	const d = Date.UTC(aarN, mndN, dagN, time ? +time : 23, min ? +min : 59, sek ? +sek : 59, ms ? +ms.padEnd(3, '0') : 999);
	return new Date(d).toISOString();
}

export function parseReferanse(v: unknown): { type: string | null; id: string } | null {
	let ref: string | undefined;
	if (typeof v === 'string') ref = v;
	else if (isObj(v) && typeof v.reference === 'string') ref = v.reference;
	if (!ref) return null;
	if (ref.startsWith('urn:uuid:')) return { type: null, id: ref.slice('urn:uuid:'.length) };
	const deler = ref.split('/').filter(Boolean);
	if (deler.length >= 2) {
		const id = deler[deler.length - 1];
		const type = deler[deler.length - 2];
		return { type, id: id.split('/_history/')[0] };
	}
	return { type: null, id: ref };
}

function tomRad(param: string, kind: ParamKind): IndexRad {
	return {
		param, kind,
		value_string: null, token_system: null, token_code: null,
		ref_type: null, ref_id: null,
		num_low: null, num_high: null, date_low: null, date_high: null
	};
}

function tokenRader(param: string, v: unknown): IndexRad[] {
	const rader: IndexRad[] = [];
	const legg = (system: string | null, code: string | null, tekst?: string | null) => {
		if (code === null && !tekst) return;
		const r = tomRad(param, 'token');
		r.token_system = system;
		r.token_code = code;
		r.value_string = tekst ? normaliserTekst(tekst) : code ? normaliserTekst(code) : null;
		rader.push(r);
	};
	if (typeof v === 'string') legg(null, v);
	else if (typeof v === 'boolean') legg(null, String(v));
	else if (typeof v === 'number') legg(null, String(v));
	else if (isObj(v)) {
		if (Array.isArray(v.coding)) {
			for (const c of v.coding) {
				if (isObj(c)) legg((c.system as string) ?? null, (c.code as string) ?? null, (c.display as string) ?? null);
			}
			if (typeof v.text === 'string') legg(null, null, v.text);
		} else if ('code' in v || 'system' in v) {
			legg((v.system as string) ?? null, (v.code as string) ?? null, (v.display as string) ?? null);
		} else if ('value' in v) {
			// Identifier eller ContactPoint
			legg((v.system as string) ?? null, (v.value as string) ?? null);
		} else if (typeof v.text === 'string') {
			legg(null, null, v.text);
		}
	}
	return rader;
}

function strengRader(param: string, v: unknown): IndexRad[] {
	const verdier: string[] = [];
	const samle = (x: unknown) => {
		if (typeof x === 'string') verdier.push(x);
		else if (isObj(x)) {
			for (const nokkel of ['text', 'family', 'given', 'line', 'city', 'postalCode', 'district', 'state', 'value']) {
				const del = x[nokkel];
				if (typeof del === 'string') verdier.push(del);
				else if (Array.isArray(del)) verdier.push(...del.filter((d): d is string => typeof d === 'string'));
			}
		}
	};
	samle(v);
	return verdier.filter(Boolean).map((s) => {
		const r = tomRad(param, 'string');
		r.value_string = normaliserTekst(s);
		return r;
	});
}

export function radeFraVerdi(param: string, def: SearchParamDef, v: unknown): IndexRad[] {
	switch (def.kind) {
		case 'token':
			return tokenRader(param, v);
		case 'string':
			return strengRader(param, v);
		case 'uri': {
			if (typeof v !== 'string') return [];
			const r = tomRad(param, 'uri');
			r.value_string = v;
			return [r];
		}
		case 'reference': {
			const ref = parseReferanse(v);
			if (!ref) return [];
			const r = tomRad(param, 'reference');
			r.ref_type = ref.type;
			r.ref_id = ref.id;
			r.value_string = ref.type ? `${ref.type}/${ref.id}` : ref.id;
			return [r];
		}
		case 'date': {
			const iv = datoIntervall(v);
			if (!iv) return [];
			const r = tomRad(param, 'date');
			r.date_low = iv.lav;
			r.date_high = iv.hoy;
			return [r];
		}
		case 'number':
		case 'quantity': {
			let tall: number | null = null;
			let system: string | null = null;
			let kode: string | null = null;
			if (typeof v === 'number') tall = v;
			else if (isObj(v) && typeof v.value === 'number') {
				tall = v.value;
				system = (v.system as string) ?? null;
				kode = ((v.code as string) ?? (v.unit as string)) ?? null;
			}
			if (tall === null) return [];
			const r = tomRad(param, def.kind);
			r.num_low = tall;
			r.num_high = tall;
			r.token_system = system;
			r.token_code = kode;
			return [r];
		}
	}
}

/** Bygger alle indeksrader for en ressurs. */
export function indekser(ressurs: FhirResource): IndexRad[] {
	const definisjoner = { ...FELLES_PARAMS, ...(SEARCH_PARAMS[ressurs.resourceType] ?? {}) };
	const rader: IndexRad[] = [];
	const sett = new Set<string>();
	for (const [navn, def] of Object.entries(definisjoner)) {
		for (const sti of def.paths) {
			for (const v of hentVerdier(ressurs, sti)) {
				for (const rad of radeFraVerdi(navn, def, v)) {
					const nokkel = JSON.stringify(rad);
					if (sett.has(nokkel)) continue;
					sett.add(nokkel);
					rader.push(rad);
				}
			}
		}
	}
	return rader;
}
