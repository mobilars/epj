import { fhirKlient } from './client';
import { FhirError, issue } from './outcome';
import { valider } from './validate';
import { PASIENTKOMPARTMENT, SEARCH_PARAMS } from './searchparams';
import type { Bundle, FhirResource } from './types';
import { config } from '../config';
import { fhirBaseFor, krevTenant, utstederFor } from '../tenant/kontekst';
import type { AuthContext } from '../authz/context';
import { pasientIdFraRessurs, sperredePasienter, tillattePasienter, vurder } from '../authz/tilgang';
import type { Operasjon } from '../authz/scopes';
import { aktorFraKontekst, logg } from '../audit';

/**
 * Vokteren foran HAPI FHIR.
 *
 * Alle FHIR-kall - fra journalens eget grensesnitt, fra SMART-apper og fra
 * backend-tjenester - går gjennom denne modulen. Her, og bare her, håndheves:
 *
 *  - SMART-scope og rolle (`authz/tilgang.ts`)
 *  - tjenstlig behov: søk avgrenses til pasienter brukeren har relasjon til
 *  - sperring: pasienter som har sperret journalen filtreres bort
 *  - sikkerhetslogg: hvert kall gir et AuditEvent, også de som avvises
 *
 * HAPI selv er ikke eksponert. Skulle noen få nettverkstilgang til HAPI direkte,
 * er det et brudd på nettverksdesignet, ikke en omgåelse av denne koden.
 */

export interface GatewaySvar {
	status: number;
	ressurs: FhirResource;
	headers: Record<string, string>;
}

const METODE_TIL_OPERASJON: Record<string, Operasjon> = {
	GET: 'r', HEAD: 'r', POST: 'c', PUT: 'u', PATCH: 'u', DELETE: 'd'
};

/** Søkeparametere som brukes til å avgrense på pasient per ressurstype. */
function pasientParam(resourceType: string): string | null {
	if (resourceType === 'Patient') return '_id';
	const kandidater = PASIENTKOMPARTMENT[resourceType] ?? [];
	return kandidater.includes('patient') ? 'patient' : (kandidater[0] ?? null);
}

export interface Forespørsel {
	ctx: AuthContext;
	metode: string;
	/** Sti under /fhir, f.eks. `Patient/123` eller `Observation/_search`. */
	sti: string;
	sok: URLSearchParams;
	kropp?: unknown;
	ifMatch?: string;
	ifNoneExist?: string;
}

export async function utfor(f: Forespørsel): Promise<GatewaySvar> {
	const deler = f.sti.split('/').filter(Boolean);
	const requestId = f.ctx.requestId;

	if (deler.length === 0) {
		if (f.metode === 'POST') return transaksjon(f);
		throw FhirError.ugyldig('Tom FHIR-sti');
	}
	if (deler[0] === 'metadata') return metadata(f);
	if (deler[0] === '_history') return systemhistorikk(f);
	if (deler[0].startsWith('$')) throw FhirError.ikkeStottet(`Systemoperasjonen ${deler[0]} er ikke tilgjengelig`);

	const resourceType = deler[0];
	if (!SEARCH_PARAMS[resourceType]) {
		throw FhirError.ikkeStottet(`Ressurstypen ${resourceType} er ikke støttet`);
	}

	// [type]/_search  og  [type]?...  -> søk
	if ((deler.length === 2 && deler[1] === '_search') || deler.length === 1) {
		if (f.metode === 'POST' && deler.length === 1) return opprettRessurs(f, resourceType);
		if (f.metode === 'DELETE') throw FhirError.ikkeStottet('Betinget sletting er slått av');
		return sokRessurser(f, resourceType);
	}

	if (deler.length >= 2 && deler[1].startsWith('$')) {
		return typeOperasjon(f, resourceType, deler[1]);
	}

	const id = deler[1];

	if (deler.length === 2) {
		switch (f.metode) {
			case 'GET': return lesRessurs(f, resourceType, id);
			case 'PUT': return oppdaterRessurs(f, resourceType, id);
			case 'PATCH': return patchRessurs(f, resourceType, id);
			case 'DELETE': return slettRessurs(f, resourceType, id);
			default: throw FhirError.ikkeStottet(`${f.metode} er ikke støttet på ${resourceType}/${id}`);
		}
	}

	if (deler.length === 3 && deler[2] === '_history') return ressurshistorikk(f, resourceType, id);
	if (deler.length === 4 && deler[2] === '_history') return lesVersjon(f, resourceType, id, deler[3]);
	if (deler.length === 3 && deler[2].startsWith('$')) return instansOperasjon(f, resourceType, id, deler[2]);

	throw FhirError.ugyldig(`Ukjent FHIR-sti: ${f.sti}`);
}

// ---------------------------------------------------------------------------
// Enkeltressurser
// ---------------------------------------------------------------------------

async function lesRessurs(f: Forespørsel, resourceType: string, id: string): Promise<GatewaySvar> {
	const ressurs = await fhirKlient.les(resourceType, id, { requestId: f.ctx.requestId });
	const patientId = pasientIdFraRessurs(ressurs);
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'r', ressurs, patientId });

	await logg(
		{
			type: 'rest', subtype: 'read', handling: 'R',
			utfall: beslutning.tillatt ? '0' : '4',
			utfallBeskrivelse: beslutning.grunn,
			patientId, entityRef: `${resourceType}/${id}`,
			purposeOfUse: beslutning.purposeOfUse
		},
		aktorFraKontekst(f.ctx)
	);
	if (!beslutning.tillatt) throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);

	return {
		status: 200,
		ressurs,
		headers: {
			etag: `W/"${ressurs.meta?.versionId ?? '1'}"`,
			'last-modified': ressurs.meta?.lastUpdated ?? new Date().toISOString()
		}
	};
}

async function lesVersjon(f: Forespørsel, resourceType: string, id: string, versionId: string): Promise<GatewaySvar> {
	const ressurs = await fhirKlient.lesVersjon(resourceType, id, versionId, { requestId: f.ctx.requestId });
	const patientId = pasientIdFraRessurs(ressurs);
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'r', ressurs, patientId });
	await logg(
		{ type: 'rest', subtype: 'vread', handling: 'R', utfall: beslutning.tillatt ? '0' : '4', patientId, entityRef: `${resourceType}/${id}/_history/${versionId}`, purposeOfUse: beslutning.purposeOfUse },
		aktorFraKontekst(f.ctx)
	);
	if (!beslutning.tillatt) throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
	return { status: 200, ressurs, headers: {} };
}

async function opprettRessurs(f: Forespørsel, resourceType: string): Promise<GatewaySvar> {
	const ressurs = kroppSomRessurs(f.kropp, resourceType);
	const funn = valider(ressurs, resourceType).filter((i) => i.severity === 'error' || i.severity === 'fatal');
	if (funn.length > 0) throw new FhirError(422, funn);

	const patientId = pasientIdFraRessurs(ressurs);
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'c', ressurs, patientId });
	if (!beslutning.tillatt) {
		await logg({ type: 'rest', subtype: 'create', handling: 'C', utfall: '4', utfallBeskrivelse: beslutning.grunn, patientId, entityRef: resourceType, purposeOfUse: beslutning.purposeOfUse }, aktorFraKontekst(f.ctx));
		throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
	}

	const svar = await fhirKlient.opprett(medProvenance(ressurs, f.ctx), {
		requestId: f.ctx.requestId,
		ifNoneExist: f.ifNoneExist
	});
	await logg(
		{ type: 'rest', subtype: 'create', handling: 'C', utfall: '0', patientId, entityRef: `${resourceType}/${svar.ressurs.id}`, purposeOfUse: beslutning.purposeOfUse },
		aktorFraKontekst(f.ctx)
	);
	return {
		status: svar.status,
		ressurs: svar.ressurs,
		headers: {
			location: `${fhirBaseFor(krevTenant())}/${resourceType}/${svar.ressurs.id}`,
			...(svar.etag ? { etag: svar.etag } : {})
		}
	};
}

async function oppdaterRessurs(f: Forespørsel, resourceType: string, id: string): Promise<GatewaySvar> {
	const ny = kroppSomRessurs(f.kropp, resourceType);
	const funn = valider({ ...ny, id }, resourceType).filter((i) => i.severity === 'error' || i.severity === 'fatal');
	if (funn.length > 0) throw new FhirError(422, funn);

	// Tilgang må vurderes både mot den nye og den eksisterende versjonen: en
	// bruker skal ikke kunne flytte en ressurs over på «sin» pasient.
	const eksisterende = await fhirKlient.les(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	for (const kandidat of [ny, eksisterende].filter(Boolean) as FhirResource[]) {
		const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'u', ressurs: kandidat, patientId: pasientIdFraRessurs(kandidat) });
		if (!beslutning.tillatt) {
			await logg({ type: 'rest', subtype: 'update', handling: 'U', utfall: '4', utfallBeskrivelse: beslutning.grunn, patientId: pasientIdFraRessurs(kandidat), entityRef: `${resourceType}/${id}`, purposeOfUse: beslutning.purposeOfUse }, aktorFraKontekst(f.ctx));
			throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
		}
	}

	const svar = await fhirKlient.oppdater(resourceType, id, medProvenance(ny, f.ctx), {
		requestId: f.ctx.requestId,
		ifMatch: f.ifMatch
	});
	await logg(
		{ type: 'rest', subtype: 'update', handling: 'U', utfall: '0', patientId: pasientIdFraRessurs(ny), entityRef: `${resourceType}/${id}`, purposeOfUse: 'TREAT' },
		aktorFraKontekst(f.ctx)
	);
	return { status: svar.status, ressurs: svar.ressurs, headers: svar.etag ? { etag: svar.etag } : {} };
}

async function patchRessurs(f: Forespørsel, resourceType: string, id: string): Promise<GatewaySvar> {
	const eksisterende = await fhirKlient.les(resourceType, id, { requestId: f.ctx.requestId });
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'u', ressurs: eksisterende, patientId: pasientIdFraRessurs(eksisterende) });
	if (!beslutning.tillatt) throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
	if (!Array.isArray(f.kropp)) throw FhirError.ugyldig('PATCH krever en JSON Patch-array');

	const svar = await fhirKlient.patch(resourceType, id, f.kropp as unknown[], { requestId: f.ctx.requestId, ifMatch: f.ifMatch });
	await logg(
		{ type: 'rest', subtype: 'patch', handling: 'U', utfall: '0', patientId: pasientIdFraRessurs(eksisterende), entityRef: `${resourceType}/${id}`, purposeOfUse: beslutning.purposeOfUse },
		aktorFraKontekst(f.ctx)
	);
	return { status: svar.status, ressurs: svar.ressurs, headers: {} };
}

async function slettRessurs(f: Forespørsel, resourceType: string, id: string): Promise<GatewaySvar> {
	const eksisterende = await fhirKlient.les(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	const patientId = eksisterende ? pasientIdFraRessurs(eksisterende) : null;
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'd', ressurs: eksisterende, patientId, ressursId: id });
	if (!beslutning.tillatt) {
		await logg({ type: 'rest', subtype: 'delete', handling: 'D', utfall: '4', utfallBeskrivelse: beslutning.grunn, patientId, entityRef: `${resourceType}/${id}` }, aktorFraKontekst(f.ctx));
		throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
	}
	// Journalinnhold skal ikke slettes uten vedtak; markering som feilført er
	// hovedveien (`entered-in-error`). Sletting her fjerner ressursen fra søk,
	// mens HAPI beholder versjonshistorikken.
	const svar = await fhirKlient.slett(resourceType, id, { requestId: f.ctx.requestId });
	await logg(
		{ type: 'rest', subtype: 'delete', handling: 'D', utfall: '0', patientId, entityRef: `${resourceType}/${id}`, purposeOfUse: beslutning.purposeOfUse },
		aktorFraKontekst(f.ctx)
	);
	return { status: svar.status === 204 ? 200 : svar.status, ressurs: svar.ressurs ?? { resourceType: 'OperationOutcome', issue: [issue('information', 'informational', 'Slettet')] }, headers: {} };
}

// ---------------------------------------------------------------------------
// Søk
// ---------------------------------------------------------------------------

async function sokRessurser(f: Forespørsel, resourceType: string): Promise<GatewaySvar> {
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 's' });
	if (!beslutning.tillatt) {
		await logg({ type: 'rest', subtype: 'search-type', handling: 'E', utfall: '4', utfallBeskrivelse: beslutning.grunn, entityRef: resourceType }, aktorFraKontekst(f.ctx));
		throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
	}

	const sok = new URLSearchParams(f.sok);
	if (f.metode === 'POST' && f.kropp instanceof URLSearchParams) {
		for (const [k, v] of f.kropp) sok.append(k, v);
	}

	// Tvinger inn scope-begrensninger, f.eks. `patient/Observation.rs?category=vital-signs`.
	for (const begrensning of beslutning.begrensninger) {
		for (const [k, v] of begrensning) sok.append(k, v);
	}

	// Avgrensning til pasienter brukeren faktisk har tjenstlig behov for.
	const tillatte = await tillattePasienter(f.ctx);
	const param = pasientParam(resourceType);
	if (tillatte !== 'alle' && param) {
		if (tillatte.length === 0) {
			return { status: 200, ressurs: tomBundle(), headers: {} };
		}
		sok.append(param, tillatte.map((id) => (param === '_id' ? id : `Patient/${id}`)).join(','));
	}

	const grense = Math.min(Number(sok.get('_count') ?? 50), 200);
	sok.set('_count', String(grense));

	const bundle = await fhirKlient.sok(resourceType, sok, { requestId: f.ctx.requestId });

	// Etterfilter for sperringer. Sperring kan endres mellom to kall, og HAPI
	// kjenner ikke sperringsmodellen, så filteret gjøres her.
	const sperret = await sperredePasienter(f.ctx);
	const beholdt = (bundle.entry ?? []).filter((e) => {
		if (!e.resource) return true;
		const p = pasientIdFraRessurs(e.resource);
		return !p || !sperret.has(p);
	});
	const fjernet = (bundle.entry ?? []).length - beholdt.length;

	await logg(
		{
			type: 'rest', subtype: 'search-type', handling: 'E', utfall: '0',
			entityRef: resourceType, purposeOfUse: beslutning.purposeOfUse,
			detaljer: { antall: beholdt.length, filtrertBortSperret: fjernet, spørring: renseForLogg(sok) }
		},
		aktorFraKontekst(f.ctx)
	);

	return {
		status: 200,
		ressurs: { ...bundle, entry: beholdt, total: typeof bundle.total === 'number' ? bundle.total - fjernet : undefined } as FhirResource,
		headers: {}
	};
}

/** Fjerner identifikatorer fra spørringen før den lagres i loggen. */
function renseForLogg(sok: URLSearchParams): string {
	const kopi = new URLSearchParams(sok);
	for (const nokkel of ['identifier', 'name', 'family', 'given', 'phone', 'email', 'telecom', 'address']) {
		if (kopi.has(nokkel)) kopi.set(nokkel, '[maskert]');
	}
	return kopi.toString().slice(0, 500);
}

function tomBundle(): FhirResource {
	return { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] };
}

// ---------------------------------------------------------------------------
// Historikk, operasjoner og transaksjoner
// ---------------------------------------------------------------------------

async function ressurshistorikk(f: Forespørsel, resourceType: string, id: string): Promise<GatewaySvar> {
	const ressurs = await fhirKlient.les(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	const patientId = ressurs ? pasientIdFraRessurs(ressurs) : null;
	const beslutning = await vurder({ ctx: f.ctx, resourceType, operasjon: 'r', ressurs, patientId, ressursId: id });
	if (!beslutning.tillatt) throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
	const bundle = await fhirKlient.historikk(resourceType, id, f.sok, { requestId: f.ctx.requestId });
	await logg({ type: 'rest', subtype: 'history-instance', handling: 'R', utfall: '0', patientId, entityRef: `${resourceType}/${id}`, purposeOfUse: beslutning.purposeOfUse }, aktorFraKontekst(f.ctx));
	return { status: 200, ressurs: bundle as FhirResource, headers: {} };
}

async function systemhistorikk(f: Forespørsel): Promise<GatewaySvar> {
	if (!f.ctx.rettigheter.has('admin:logg')) throw FhirError.ikkeTillatt('Systemhistorikk krever administratorrettigheter');
	const bundle = await fhirKlient.operasjon(`_history?${f.sok}`, undefined, { requestId: f.ctx.requestId });
	await logg({ type: 'rest', subtype: 'history-system', handling: 'R', utfall: '0' }, aktorFraKontekst(f.ctx));
	return { status: 200, ressurs: bundle, headers: {} };
}

async function typeOperasjon(f: Forespørsel, resourceType: string, operasjon: string): Promise<GatewaySvar> {
	if (operasjon === '$validate') {
		const ressurs = kroppSomRessurs(f.kropp, resourceType);
		const lokal = valider(ressurs, resourceType);
		const fra = await fhirKlient.valider(ressurs, undefined, { requestId: f.ctx.requestId });
		const samlet = [...lokal, ...((fra as { issue?: unknown[] }).issue ?? [])];
		return { status: 200, ressurs: { resourceType: 'OperationOutcome', issue: samlet.length ? samlet : [issue('information', 'informational', 'Ingen feil funnet')] }, headers: {} };
	}
	throw FhirError.ikkeStottet(`Operasjonen ${operasjon} på ${resourceType} er ikke tilgjengelig`);
}

async function instansOperasjon(f: Forespørsel, resourceType: string, id: string, operasjon: string): Promise<GatewaySvar> {
	if (resourceType === 'Patient' && operasjon === '$everything') {
		const beslutning = await vurder({ ctx: f.ctx, resourceType: 'Patient', operasjon: 'r', patientId: id, ressursId: id });
		await logg(
			{ type: 'rest', subtype: 'operation', handling: 'R', utfall: beslutning.tillatt ? '0' : '4', utfallBeskrivelse: beslutning.grunn, patientId: id, entityRef: `Patient/${id}/$everything`, purposeOfUse: beslutning.purposeOfUse },
			aktorFraKontekst(f.ctx)
		);
		if (!beslutning.tillatt) throw new FhirError(beslutning.status, [issue('error', 'forbidden', beslutning.grunn ?? 'Ingen tilgang')]);
		const bundle = await fhirKlient.everything(id, f.sok, { requestId: f.ctx.requestId });
		return { status: 200, ressurs: filtrerBundlePaScope(bundle, f.ctx), headers: {} };
	}
	throw FhirError.ikkeStottet(`Operasjonen ${operasjon} er ikke tilgjengelig`);
}

/** Fjerner ressurstyper appen ikke har lesescope for fra en samlebundle. */
function filtrerBundlePaScope(bundle: Bundle, ctx: AuthContext): FhirResource {
	const tillatt = (type: string) =>
		ctx.scopes.kliniske.some((s) => (s.ressurs === '*' || s.ressurs === type) && (s.operasjoner.has('r') || s.operasjoner.has('s')));
	const entry = (bundle.entry ?? []).filter((e) => !e.resource || tillatt(e.resource.resourceType));
	return { ...bundle, entry } as FhirResource;
}

async function transaksjon(f: Forespørsel): Promise<GatewaySvar> {
	const bundle = f.kropp as Bundle;
	if (!bundle || bundle.resourceType !== 'Bundle') throw FhirError.ugyldig('Forventet en Bundle');
	if (bundle.type !== 'transaction' && bundle.type !== 'batch') {
		throw FhirError.ugyldig('Bundle.type må være «transaction» eller «batch»');
	}

	// Hver oppføring vurderes for seg. En transaksjon skal ikke kunne brukes til
	// å omgå tilgangskontrollen ved å pakke inn kall brukeren ikke har lov til.
	for (const entry of bundle.entry ?? []) {
		const metode = entry.request?.method ?? 'POST';
		const url = entry.request?.url ?? '';
		const resourceType = entry.resource?.resourceType ?? url.split('/')[0].split('?')[0];
		if (!resourceType) throw FhirError.ugyldig('Oppføring i Bundle mangler ressurstype');
		const operasjon = METODE_TIL_OPERASJON[metode] ?? 'r';
		const beslutning = await vurder({
			ctx: f.ctx, resourceType, operasjon,
			ressurs: entry.resource ?? null,
			patientId: entry.resource ? pasientIdFraRessurs(entry.resource) : null
		});
		if (!beslutning.tillatt) {
			await logg({ type: 'rest', subtype: 'transaction', handling: 'E', utfall: '4', utfallBeskrivelse: beslutning.grunn, entityRef: `${metode} ${url}` }, aktorFraKontekst(f.ctx));
			throw new FhirError(beslutning.status, [issue('error', 'forbidden', `${metode} ${url}: ${beslutning.grunn}`)]);
		}
	}

	const merket: Bundle = {
		...bundle,
		entry: (bundle.entry ?? []).map((e) => (e.resource ? { ...e, resource: medProvenance(e.resource, f.ctx) } : e))
	};
	const svar = await fhirKlient.transaksjon(merket, { requestId: f.ctx.requestId });
	await logg(
		{ type: 'rest', subtype: 'transaction', handling: 'E', utfall: '0', detaljer: { oppføringer: (bundle.entry ?? []).length } },
		aktorFraKontekst(f.ctx)
	);
	return { status: 200, ressurs: svar as FhirResource, headers: {} };
}

async function metadata(f: Forespørsel): Promise<GatewaySvar> {
	const fra = await fhirKlient.capabilityStatement({ requestId: f.ctx.requestId });
	return { status: 200, ressurs: berikCapabilityStatement(fra), headers: {} };
}

/** Legger SMART on FHIR-utvidelsen på HAPI sin CapabilityStatement. */
export function berikCapabilityStatement(fra: FhirResource): FhirResource {
	const tenant = krevTenant();
	const base = utstederFor(tenant);
	const rest = Array.isArray(fra.rest) ? [...(fra.rest as Record<string, unknown>[])] : [{ mode: 'server' }];
	rest[0] = {
		...rest[0],
		security: {
			cors: true,
			service: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/restful-security-service', code: 'SMART-on-FHIR' }] }],
			extension: [
				{
					url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
					extension: [
						{ url: 'authorize', valueUri: `${base}/oauth/authorize` },
						{ url: 'token', valueUri: `${base}/oauth/token` },
						{ url: 'introspect', valueUri: `${base}/oauth/introspect` },
						{ url: 'revoke', valueUri: `${base}/oauth/revoke` },
						{ url: 'register', valueUri: `${base}/oauth/register` },
						{ url: 'manage', valueUri: `${base}/admin/apper` }
					]
				}
			]
		}
	};
	return {
		...fra,
		publisher: tenant.navn,
		implementation: { description: `EPJ for fastleger - ${tenant.navn}`, url: fhirBaseFor(tenant) },
		rest
	};
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner
// ---------------------------------------------------------------------------

function kroppSomRessurs(kropp: unknown, forventetType: string): FhirResource {
	if (typeof kropp !== 'object' || kropp === null || Array.isArray(kropp)) {
		throw FhirError.ugyldig('Forventet en FHIR-ressurs som JSON');
	}
	const r = kropp as FhirResource;
	if (r.resourceType !== forventetType) {
		throw FhirError.ugyldig(`Forventet ${forventetType}, fikk ${r.resourceType ?? 'ukjent'}`);
	}
	return r;
}

/**
 * Merker ressursen med hvem som skrev den. HAPI fører versjonshistorikken;
 * denne taggen gjør at forfatteren også er synlig i selve ressursen, slik
 * EPJ-standarden krever for signering og kontrasignering.
 */
function medProvenance(ressurs: FhirResource, ctx: AuthContext): FhirResource {
	const kilde = ctx.clientId ? `${ctx.actorRef} via ${ctx.clientId}` : ctx.actorRef;
	return {
		...ressurs,
		meta: {
			...(ressurs.meta ?? {}),
			source: `urn:epj:${kilde}`,
			tag: [
				...(ressurs.meta?.tag ?? []).filter((t) => t.system !== 'urn:epj:forfatter'),
				{ system: 'urn:epj:forfatter', code: ctx.actorRef, display: ctx.navn }
			]
		}
	};
}
