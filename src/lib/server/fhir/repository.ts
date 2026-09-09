import { all, get, run, transaction } from '../db';
import { naa, nyId } from '../util/ids';
import { indekser } from './indexing';
import { FhirError } from './outcome';
import { validerEllerKast } from './validate';
import type { Bundle, BundleEntry, FhirResource } from './types';
import { sok, type SokeOpsjoner, type SokeResultat } from './search';

export interface SkriveKontekst {
	/** FHIR-referanse til den som utfører endringen, f.eks. `Practitioner/123`. */
	actorRef: string;
	actorNavn: string;
}

interface ResourceRad {
	resource_type: string;
	id: string;
	version_id: number;
	last_updated: string;
	deleted: number;
	content: string;
}

function tilRessurs(rad: ResourceRad): FhirResource {
	const r = JSON.parse(rad.content) as FhirResource;
	r.meta = { ...(r.meta ?? {}), versionId: String(rad.version_id), lastUpdated: rad.last_updated };
	return r;
}

export function les(resourceType: string, id: string): FhirResource {
	const rad = get<ResourceRad>('SELECT * FROM resource WHERE resource_type = ? AND id = ?', resourceType, id);
	if (!rad) throw FhirError.ikkeFunnet(`${resourceType}/${id} finnes ikke`);
	if (rad.deleted) throw new FhirError(410, [{ severity: 'error', code: 'deleted', diagnostics: `${resourceType}/${id} er slettet` }]);
	return tilRessurs(rad);
}

export function lesHvisFinnes(resourceType: string, id: string): FhirResource | null {
	const rad = get<ResourceRad>('SELECT * FROM resource WHERE resource_type = ? AND id = ? AND deleted = 0', resourceType, id);
	return rad ? tilRessurs(rad) : null;
}

export function lesVersjon(resourceType: string, id: string, versionId: string): FhirResource {
	const rad = get<{ content: string | null; last_updated: string; version_id: number; method: string }>(
		'SELECT content, last_updated, version_id, method FROM resource_history WHERE resource_type = ? AND id = ? AND version_id = ?',
		resourceType, id, Number(versionId)
	);
	if (!rad) throw FhirError.ikkeFunnet(`${resourceType}/${id} versjon ${versionId} finnes ikke`);
	if (!rad.content) throw new FhirError(410, [{ severity: 'error', code: 'deleted', diagnostics: 'Versjonen er en sletting' }]);
	const r = JSON.parse(rad.content) as FhirResource;
	r.meta = { ...(r.meta ?? {}), versionId: String(rad.version_id), lastUpdated: rad.last_updated };
	return r;
}

export function historikk(resourceType: string, id: string, count = 50): FhirResource[] {
	const rader = all<{ content: string | null; version_id: number; last_updated: string; method: string; author_navn: string | null }>(
		'SELECT content, version_id, last_updated, method, author_navn FROM resource_history WHERE resource_type = ? AND id = ? ORDER BY version_id DESC LIMIT ?',
		resourceType, id, count
	);
	return rader.map((rad) => {
		if (!rad.content) {
			return { resourceType, id, meta: { versionId: String(rad.version_id), lastUpdated: rad.last_updated }, _slettet: true } as FhirResource;
		}
		const r = JSON.parse(rad.content) as FhirResource;
		r.meta = { ...(r.meta ?? {}), versionId: String(rad.version_id), lastUpdated: rad.last_updated };
		return r;
	});
}

function skrivIndeks(ressurs: FhirResource): void {
	run('DELETE FROM search_index WHERE resource_type = ? AND resource_id = ?', ressurs.resourceType, ressurs.id ?? '');
	for (const rad of indekser(ressurs)) {
		run(
			`INSERT INTO search_index (resource_type, resource_id, param, kind, value_string, token_system, token_code, ref_type, ref_id, num_low, num_high, date_low, date_high)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			ressurs.resourceType, ressurs.id ?? '', rad.param, rad.kind,
			rad.value_string, rad.token_system, rad.token_code, rad.ref_type, rad.ref_id,
			rad.num_low, rad.num_high, rad.date_low, rad.date_high
		);
	}
}

function lagre(ressurs: FhirResource, versjon: number, tid: string, metode: string, ctx: SkriveKontekst): FhirResource {
	const komplett: FhirResource = {
		...ressurs,
		meta: { ...(ressurs.meta ?? {}), versionId: String(versjon), lastUpdated: tid }
	};
	const innhold = JSON.stringify(komplett);
	run(
		`INSERT INTO resource (resource_type, id, version_id, last_updated, deleted, content) VALUES (?,?,?,?,0,?)
		 ON CONFLICT(resource_type, id) DO UPDATE SET version_id = excluded.version_id, last_updated = excluded.last_updated, deleted = 0, content = excluded.content`,
		komplett.resourceType, komplett.id ?? '', versjon, tid, innhold
	);
	run(
		'INSERT INTO resource_history (resource_type, id, version_id, last_updated, method, author_ref, author_navn, content) VALUES (?,?,?,?,?,?,?,?)',
		komplett.resourceType, komplett.id ?? '', versjon, tid, metode, ctx.actorRef, ctx.actorNavn, innhold
	);
	skrivIndeks(komplett);
	return komplett;
}

export function opprett(ressurs: FhirResource, ctx: SkriveKontekst, id?: string): FhirResource {
	validerEllerKast(ressurs, ressurs.resourceType);
	return transaction(() => {
		const nyIdent = id ?? ressurs.id ?? nyId();
		const finnes = get<{ id: string }>('SELECT id FROM resource WHERE resource_type = ? AND id = ?', ressurs.resourceType, nyIdent);
		if (finnes) throw FhirError.konflikt(`${ressurs.resourceType}/${nyIdent} finnes allerede`);
		return lagre({ ...ressurs, id: nyIdent }, 1, naa(), 'POST', ctx);
	});
}

export function oppdater(
	resourceType: string,
	id: string,
	ressurs: FhirResource,
	ctx: SkriveKontekst,
	ifMatch?: string
): { ressurs: FhirResource; opprettet: boolean } {
	validerEllerKast({ ...ressurs, resourceType }, resourceType);
	return transaction(() => {
		const eksisterende = get<ResourceRad>('SELECT * FROM resource WHERE resource_type = ? AND id = ?', resourceType, id);
		if (ifMatch) {
			const forventet = ifMatch.replace(/^W\//, '').replace(/"/g, '');
			if (!eksisterende || String(eksisterende.version_id) !== forventet) {
				throw FhirError.forUtdatert();
			}
		}
		const versjon = eksisterende ? eksisterende.version_id + 1 : 1;
		const lagret = lagre({ ...ressurs, resourceType, id }, versjon, naa(), eksisterende ? 'PUT' : 'POST', ctx);
		return { ressurs: lagret, opprettet: !eksisterende || eksisterende.deleted === 1 };
	});
}

/**
 * Sletting fjerner ressursen fra søk, men beholder alle tidligere versjoner.
 * Journalinnhold skal aldri slettes fysisk uten vedtak - se `slettEndelig`.
 */
export function slett(resourceType: string, id: string, ctx: SkriveKontekst): { slettet: boolean; versjon: number } {
	return transaction(() => {
		const eksisterende = get<ResourceRad>('SELECT * FROM resource WHERE resource_type = ? AND id = ?', resourceType, id);
		if (!eksisterende) return { slettet: false, versjon: 0 };
		if (eksisterende.deleted) return { slettet: false, versjon: eksisterende.version_id };
		const versjon = eksisterende.version_id + 1;
		const tid = naa();
		run('UPDATE resource SET deleted = 1, version_id = ?, last_updated = ? WHERE resource_type = ? AND id = ?', versjon, tid, resourceType, id);
		run(
			'INSERT INTO resource_history (resource_type, id, version_id, last_updated, method, author_ref, author_navn, content) VALUES (?,?,?,?,?,?,?,NULL)',
			resourceType, id, versjon, tid, 'DELETE', ctx.actorRef, ctx.actorNavn
		);
		run('DELETE FROM search_index WHERE resource_type = ? AND resource_id = ?', resourceType, id);
		return { slettet: true, versjon };
	});
}

/**
 * Endelig sletting etter pasientjournalloven § 26 / helsepersonelloven § 43.
 * Fjerner også historikk, og skal bare kalles etter dokumentert vedtak.
 * Selve vedtaket registreres av kalleren som Provenance + AuditEvent.
 */
export function slettEndelig(resourceType: string, id: string): void {
	transaction(() => {
		run('DELETE FROM search_index WHERE resource_type = ? AND resource_id = ?', resourceType, id);
		run('DELETE FROM resource_history WHERE resource_type = ? AND id = ?', resourceType, id);
		run('DELETE FROM resource WHERE resource_type = ? AND id = ?', resourceType, id);
	});
}

export function sokRessurser(resourceType: string, query: URLSearchParams, opsjoner?: SokeOpsjoner): SokeResultat {
	return sok(resourceType, query, opsjoner);
}

/** Betinget oppslag brukt av `ifNoneExist` og betinget oppdatering. */
export function finnEn(resourceType: string, query: URLSearchParams): FhirResource | null {
	const resultat = sok(resourceType, new URLSearchParams([...query, ['_count', '2']]));
	if (resultat.total > 1) throw FhirError.konflikt(`Flere treff for betinget operasjon på ${resourceType}`);
	return resultat.treff[0] ?? null;
}

/** Kjører en transaction- eller batch-Bundle. */
export function kjorBundle(
	bundle: Bundle,
	ctx: SkriveKontekst,
	utfor: (metode: string, url: string, ressurs: FhirResource | undefined, entry: BundleEntry) => BundleEntry
): Bundle {
	if (bundle.resourceType !== 'Bundle') throw FhirError.ugyldig('Forventet en Bundle');
	if (bundle.type !== 'transaction' && bundle.type !== 'batch') {
		throw FhirError.ugyldig('Bundle.type må være «transaction» eller «batch»');
	}
	const oppføringer = bundle.entry ?? [];
	const kjor = (): BundleEntry[] =>
		oppføringer.map((entry) => {
			const metode = entry.request?.method ?? 'POST';
			const url = entry.request?.url ?? '';
			return utfor(metode, url, entry.resource, entry);
		});

	const svar = bundle.type === 'transaction' ? transaction(kjor) : kjor();
	return {
		resourceType: 'Bundle',
		type: bundle.type === 'transaction' ? 'transaction-response' : 'batch-response',
		entry: svar
	};
}

export function systemHistorikk(count: number, since?: string): FhirResource[] {
	const rader = since
		? all<{ content: string | null; resource_type: string; id: string; version_id: number; last_updated: string }>(
				'SELECT * FROM resource_history WHERE last_updated > ? ORDER BY last_updated DESC LIMIT ?', since, count
			)
		: all<{ content: string | null; resource_type: string; id: string; version_id: number; last_updated: string }>(
				'SELECT * FROM resource_history ORDER BY last_updated DESC LIMIT ?', count
			);
	return rader
		.filter((r) => r.content)
		.map((r) => JSON.parse(r.content as string) as FhirResource);
}
