import { fhirClient } from './client';
import { FhirError, issue } from './outcome';
import { validate } from './validate';
import { PATIENTCOMPARTMENT, SEARCH_PARAMS } from './searchparams';
import type { Bundle, FhirResource } from './types';
import { config } from '../config';
import { fhirBaseFor, requireTenant, issuerFor } from '../tenant/context';
import type { AuthContext } from '../authz/context';
import { isPatientRelated, patientIdFromResource, blockedPatients, allowedPatients, evaluate } from '../authz/access';
import type { Operation } from '../authz/scopes';
import { actorFromContext, log } from '../audit';

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

export interface GatewayResponse {
	status: number;
	resource: FhirResource;
	headers: Record<string, string>;
}

const METHOD_TO_OPERATION: Record<string, Operation> = {
	GET: 'r', HEAD: 'r', POST: 'c', PUT: 'u', PATCH: 'u', DELETE: 'd'
};

/** Søkeparametere som brukes til å avgrense på pasient per ressurstype. */
function patientParam(resourceType: string): string | null {
	if (resourceType === 'Patient') return '_id';
	const candidates = PATIENTCOMPARTMENT[resourceType] ?? [];
	return candidates.includes('patient') ? 'patient' : (candidates[0] ?? null);
}

export interface Request {
	ctx: AuthContext;
	method: string;
	/** Sti under /fhir, f.eks. `Patient/123` eller `Observation/_search`. */
	path: string;
	search: URLSearchParams;
	body?: unknown;
	ifMatch?: string;
	ifNoneExist?: string;
}

export async function execute(f: Request): Promise<GatewayResponse> {
	const parts = f.path.split('/').filter(Boolean);
	const requestId = f.ctx.requestId;

	if (parts.length === 0) {
		if (f.method === 'POST') return transaction(f);
		throw FhirError.invalid('Tom FHIR-sti');
	}
	if (parts[0] === 'metadata') return metadata(f);
	if (parts[0] === '_history') return systemhistorikk(f);
	if (parts[0].startsWith('$')) throw FhirError.notStottet(`Systemoperasjonen ${parts[0]} er ikke tilgjengelig`);

	const resourceType = parts[0];
	if (!SEARCH_PARAMS[resourceType]) {
		throw FhirError.notStottet(`Ressurstypen ${resourceType} er ikke støttet`);
	}

	// [type]/_search  og  [type]?...  -> søk
	if ((parts.length === 2 && parts[1] === '_search') || parts.length === 1) {
		if (f.method === 'POST' && parts.length === 1) return createResource(f, resourceType);
		if (f.method === 'DELETE') throw FhirError.notStottet('Betinget sletting er slått av');
		return searchResources(f, resourceType);
	}

	if (parts.length >= 2 && parts[1].startsWith('$')) {
		return typeOperation(f, resourceType, parts[1]);
	}

	const id = parts[1];

	if (parts.length === 2) {
		switch (f.method) {
			case 'GET': return readResource(f, resourceType, id);
			case 'PUT': return updateResource(f, resourceType, id);
			case 'PATCH': return patchResource(f, resourceType, id);
			case 'DELETE': return deleteResource(f, resourceType, id);
			default: throw FhirError.notStottet(`${f.method} er ikke støttet på ${resourceType}/${id}`);
		}
	}

	if (parts.length === 3 && parts[2] === '_history') return ressurshistorikk(f, resourceType, id);
	if (parts.length === 4 && parts[2] === '_history') return readVersion(f, resourceType, id, parts[3]);
	if (parts.length === 3 && parts[2].startsWith('$')) return instansOperation(f, resourceType, id, parts[2]);

	throw FhirError.invalid(`Ukjent FHIR-sti: ${f.path}`);
}

// ---------------------------------------------------------------------------
// Enkeltressurser
// ---------------------------------------------------------------------------

async function readResource(f: Request, resourceType: string, id: string): Promise<GatewayResponse> {
	const resource = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId });
	const patientId = patientIdFromResource(resource);
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'r', resource, patientId });

	await log(
		{
			type: 'rest', subtype: 'read', action: 'R',
			outcome: decision.allowed ? '0' : '4',
			outcomeDescription: decision.reason,
			patientId, entityRef: `${resourceType}/${id}`,
			purposeOfUse: decision.purposeOfUse
		},
		actorFromContext(f.ctx)
	);
	if (!decision.allowed) throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);

	return {
		status: 200,
		resource,
		headers: {
			etag: `W/"${resource.meta?.versionId ?? '1'}"`,
			'last-modified': resource.meta?.loadUpdated ?? new Date().toISOString()
		}
	};
}

async function readVersion(f: Request, resourceType: string, id: string, versionId: string): Promise<GatewayResponse> {
	const resource = await fhirClient.readVersion(resourceType, id, versionId, { requestId: f.ctx.requestId });
	const patientId = patientIdFromResource(resource);
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'r', resource, patientId });
	await log(
		{ type: 'rest', subtype: 'vread', action: 'R', outcome: decision.allowed ? '0' : '4', patientId, entityRef: `${resourceType}/${id}/_history/${versionId}`, purposeOfUse: decision.purposeOfUse },
		actorFromContext(f.ctx)
	);
	if (!decision.allowed) throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	return { status: 200, resource, headers: {} };
}

async function createResource(f: Request, resourceType: string): Promise<GatewayResponse> {
	const resource = bodySomResource(f.body, resourceType);
	const findings = validate(resource, resourceType).filter((i) => i.severity === 'error' || i.severity === 'fatal');
	if (findings.length > 0) throw new FhirError(422, findings);

	const patientId = patientIdFromResource(resource);
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'c', resource, patientId });
	if (!decision.allowed) {
		await log({ type: 'rest', subtype: 'create', action: 'C', outcome: '4', outcomeDescription: decision.reason, patientId, entityRef: resourceType, purposeOfUse: decision.purposeOfUse }, actorFromContext(f.ctx));
		throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	}

	const response = await fhirClient.create(withProvenance(resource, f.ctx), {
		requestId: f.ctx.requestId,
		ifNoneExist: f.ifNoneExist
	});
	await log(
		{ type: 'rest', subtype: 'create', action: 'C', outcome: '0', patientId, entityRef: `${resourceType}/${response.resource.id}`, purposeOfUse: decision.purposeOfUse },
		actorFromContext(f.ctx)
	);
	return {
		status: response.status,
		resource: response.resource,
		headers: {
			location: `${fhirBaseFor(requireTenant())}/${resourceType}/${response.resource.id}`,
			...(response.etag ? { etag: response.etag } : {})
		}
	};
}

async function updateResource(f: Request, resourceType: string, id: string): Promise<GatewayResponse> {
	const newValue = bodySomResource(f.body, resourceType);
	const findings = validate({ ...newValue, id }, resourceType).filter((i) => i.severity === 'error' || i.severity === 'fatal');
	if (findings.length > 0) throw new FhirError(422, findings);

	// Tilgang må vurderes både mot den nye og den eksisterende versjonen: en
	// bruker skal ikke kunne flytte en ressurs over på «sin» pasient.
	const existing = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	for (const candidate of [newValue, existing].filter(Boolean) as FhirResource[]) {
		const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'u', resource: candidate, patientId: patientIdFromResource(candidate) });
		if (!decision.allowed) {
			await log({ type: 'rest', subtype: 'update', action: 'U', outcome: '4', outcomeDescription: decision.reason, patientId: patientIdFromResource(candidate), entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse }, actorFromContext(f.ctx));
			throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
		}
	}

	const response = await fhirClient.update(resourceType, id, withProvenance(newValue, f.ctx), {
		requestId: f.ctx.requestId,
		ifMatch: f.ifMatch
	});
	await log(
		{ type: 'rest', subtype: 'update', action: 'U', outcome: '0', patientId: patientIdFromResource(newValue), entityRef: `${resourceType}/${id}`, purposeOfUse: 'TREAT' },
		actorFromContext(f.ctx)
	);
	return { status: response.status, resource: response.resource, headers: response.etag ? { etag: response.etag } : {} };
}

async function patchResource(f: Request, resourceType: string, id: string): Promise<GatewayResponse> {
	const existing = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId });
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'u', resource: existing, patientId: patientIdFromResource(existing) });
	if (!decision.allowed) throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	if (!Array.isArray(f.body)) throw FhirError.invalid('PATCH krever en JSON Patch-array');

	const response = await fhirClient.patch(resourceType, id, f.body as unknown[], { requestId: f.ctx.requestId, ifMatch: f.ifMatch });
	await log(
		{ type: 'rest', subtype: 'patch', action: 'U', outcome: '0', patientId: patientIdFromResource(existing), entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse },
		actorFromContext(f.ctx)
	);
	return { status: response.status, resource: response.resource, headers: {} };
}

async function deleteResource(f: Request, resourceType: string, id: string): Promise<GatewayResponse> {
	const existing = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	const patientId = existing ? patientIdFromResource(existing) : null;
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'd', resource: existing, patientId, resourceId: id });
	if (!decision.allowed) {
		await log({ type: 'rest', subtype: 'delete', action: 'D', outcome: '4', outcomeDescription: decision.reason, patientId, entityRef: `${resourceType}/${id}` }, actorFromContext(f.ctx));
		throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	}
	// Journalinnhold skal ikke slettes uten vedtak; markering som feilført er
	// hovedveien (`entered-in-error`). Sletting her fjerner ressursen fra søk,
	// mens HAPI beholder versjonshistorikken.
	const response = await fhirClient.deleteValue(resourceType, id, { requestId: f.ctx.requestId });
	await log(
		{ type: 'rest', subtype: 'delete', action: 'D', outcome: '0', patientId, entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse },
		actorFromContext(f.ctx)
	);
	return { status: response.status === 204 ? 200 : response.status, resource: response.resource ?? { resourceType: 'OperationOutcome', issue: [issue('information', 'informational', 'Slettet')] }, headers: {} };
}

// ---------------------------------------------------------------------------
// Søk
// ---------------------------------------------------------------------------

async function searchResources(f: Request, resourceType: string): Promise<GatewayResponse> {
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 's' });
	if (!decision.allowed) {
		await log({ type: 'rest', subtype: 'search-type', action: 'E', outcome: '4', outcomeDescription: decision.reason, entityRef: resourceType }, actorFromContext(f.ctx));
		throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	}

	const search = new URLSearchParams(f.search);
	if (f.method === 'POST' && f.body instanceof URLSearchParams) {
		for (const [k, v] of f.body) search.append(k, v);
	}

	// Tvinger inn scope-begrensninger, f.eks. `patient/Observation.rs?category=vital-signs`.
	for (const limitation of decision.limitations) {
		for (const [k, v] of limitation) search.append(k, v);
	}

	// Avgrensning til pasienter brukeren faktisk har tjenstlig behov for.
	const allowed = await allowedPatients(f.ctx);
	const param = patientParam(resourceType);
	if (allowed !== 'alle') {
		// Uten et parameter å avgrense på ville spørringen gått ufiltrert til HAPI
		// og returnert hele virksomhetens data for typen. `vurder` skal allerede ha
		// avvist slike typer; dette er den andre låsen på samme dør.
		if (!param && isPatientRelated(resourceType)) {
			throw new FhirError(403, [
				issue('error', 'forbidden', `Søk i ${resourceType} kan ikke avgrenses til pasientene du har tjenstlig behov for`)
			]);
		}
		if (param) {
			if (allowed.length === 0) {
				return { status: 200, resource: emptyBundle(), headers: {} };
			}
			search.append(param, allowed.map((id) => (param === '_id' ? id : `Patient/${id}`)).join(','));
		}
	}

	const limit = Math.min(Number(search.get('_count') ?? 50), 200);
	search.set('_count', String(limit));

	const bundle = await fhirClient.search(resourceType, search, { requestId: f.ctx.requestId });

	// Etterfilter for sperringer. Sperring kan endres mellom to kall, og HAPI
	// kjenner ikke sperringsmodellen, så filteret gjøres her.
	const blocked = await blockedPatients(f.ctx);
	const kept = (bundle.entry ?? []).filter((e) => {
		if (!e.resource) return true;
		const p = patientIdFromResource(e.resource);
		return !p || !blocked.has(p);
	});
	const removed = (bundle.entry ?? []).length - kept.length;

	await log(
		{
			type: 'rest', subtype: 'search-type', action: 'E', outcome: '0',
			entityRef: resourceType, purposeOfUse: decision.purposeOfUse,
			details: { count: kept.length, filtrertBortSperret: removed, 'spørring': renseForLog(search) }
		},
		actorFromContext(f.ctx)
	);

	return {
		status: 200,
		resource: { ...bundle, entry: kept, total: typeof bundle.total === 'number' ? bundle.total - removed : undefined } as FhirResource,
		headers: {}
	};
}

/** Fjerner identifikatorer fra spørringen før den lagres i loggen. */
function renseForLog(search: URLSearchParams): string {
	const kopi = new URLSearchParams(search);
	for (const key of ['identifier', 'name', 'family', 'given', 'phone', 'email', 'telecom', 'address']) {
		if (kopi.has(key)) kopi.set(key, '[maskert]');
	}
	return kopi.toString().slice(0, 500);
}

function emptyBundle(): FhirResource {
	return { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] };
}

// ---------------------------------------------------------------------------
// Historikk, operasjoner og transaksjoner
// ---------------------------------------------------------------------------

async function ressurshistorikk(f: Request, resourceType: string, id: string): Promise<GatewayResponse> {
	const resource = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	const patientId = resource ? patientIdFromResource(resource) : null;
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'r', resource, patientId, resourceId: id });
	if (!decision.allowed) throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	const bundle = await fhirClient.history(resourceType, id, f.search, { requestId: f.ctx.requestId });
	await log({ type: 'rest', subtype: 'history-instance', action: 'R', outcome: '0', patientId, entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse }, actorFromContext(f.ctx));
	return { status: 200, resource: bundle as FhirResource, headers: {} };
}

async function systemhistorikk(f: Request): Promise<GatewayResponse> {
	if (!f.ctx.permissions.has('admin:logg')) throw FhirError.notAllowed('Systemhistorikk krever administratorrettigheter');
	const bundle = await fhirClient.operation(`_history?${f.search}`, undefined, { requestId: f.ctx.requestId });
	await log({ type: 'rest', subtype: 'history-system', action: 'R', outcome: '0' }, actorFromContext(f.ctx));
	return { status: 200, resource: bundle, headers: {} };
}

async function typeOperation(f: Request, resourceType: string, operation: string): Promise<GatewayResponse> {
	if (operation === '$validate') {
		const resource = bodySomResource(f.body, resourceType);
		const lokal = validate(resource, resourceType);
		const from = await fhirClient.validate(resource, undefined, { requestId: f.ctx.requestId });
		const combined = [...lokal, ...((from as { issue?: unknown[] }).issue ?? [])];
		return { status: 200, resource: { resourceType: 'OperationOutcome', issue: combined.length ? combined : [issue('information', 'informational', 'Ingen feil funnet')] }, headers: {} };
	}
	throw FhirError.notStottet(`Operasjonen ${operation} på ${resourceType} er ikke tilgjengelig`);
}

async function instansOperation(f: Request, resourceType: string, id: string, operation: string): Promise<GatewayResponse> {
	if (resourceType === 'Patient' && operation === '$everything') {
		const decision = await evaluate({ ctx: f.ctx, resourceType: 'Patient', operation: 'r', patientId: id, resourceId: id });
		await log(
			{ type: 'rest', subtype: 'operation', action: 'R', outcome: decision.allowed ? '0' : '4', outcomeDescription: decision.reason, patientId: id, entityRef: `Patient/${id}/$everything`, purposeOfUse: decision.purposeOfUse },
			actorFromContext(f.ctx)
		);
		if (!decision.allowed) throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
		const bundle = await fhirClient.everything(id, f.search, { requestId: f.ctx.requestId });
		return { status: 200, resource: filterBundleOnScope(bundle, f.ctx), headers: {} };
	}
	throw FhirError.notStottet(`Operasjonen ${operation} er ikke tilgjengelig`);
}

/** Fjerner ressurstyper appen ikke har lesescope for fra en samlebundle. */
function filterBundleOnScope(bundle: Bundle, ctx: AuthContext): FhirResource {
	const allowed = (type: string) =>
		ctx.scopes.clinical.some((s) => (s.resource === '*' || s.resource === type) && (s.operations.has('r') || s.operations.has('s')));
	const entry = (bundle.entry ?? []).filter((e) => !e.resource || allowed(e.resource.resourceType));
	return { ...bundle, entry } as FhirResource;
}

async function transaction(f: Request): Promise<GatewayResponse> {
	const bundle = f.body as Bundle;
	if (!bundle || bundle.resourceType !== 'Bundle') throw FhirError.invalid('Forventet en Bundle');
	if (bundle.type !== 'transaction' && bundle.type !== 'batch') {
		throw FhirError.invalid('Bundle.type må være «transaction» eller «batch»');
	}

	// Hver oppføring vurderes for seg. En transaksjon skal ikke kunne brukes til
	// å omgå tilgangskontrollen ved å pakke inn kall brukeren ikke har lov til.
	for (const entry of bundle.entry ?? []) {
		const method = entry.request?.method ?? 'POST';
		const url = entry.request?.url ?? '';
		const resourceType = entry.resource?.resourceType ?? url.split('/')[0].split('?')[0];
		if (!resourceType) throw FhirError.invalid('Oppføring i Bundle mangler ressurstype');
		const operation = METHOD_TO_OPERATION[method] ?? 'r';
		const decision = await evaluate({
			ctx: f.ctx, resourceType, operation,
			resource: entry.resource ?? null,
			patientId: entry.resource ? patientIdFromResource(entry.resource) : null
		});
		if (!decision.allowed) {
			await log({ type: 'rest', subtype: 'transaction', action: 'E', outcome: '4', outcomeDescription: decision.reason, entityRef: `${method} ${url}` }, actorFromContext(f.ctx));
			throw new FhirError(decision.status, [issue('error', 'forbidden', `${method} ${url}: ${decision.reason}`)]);
		}
	}

	const merket: Bundle = {
		...bundle,
		entry: (bundle.entry ?? []).map((e) => (e.resource ? { ...e, resource: withProvenance(e.resource, f.ctx) } : e))
	};
	const response = await fhirClient.transaction(merket, { requestId: f.ctx.requestId });
	await log(
		{ type: 'rest', subtype: 'transaction', action: 'E', outcome: '0', details: { entries: (bundle.entry ?? []).length } },
		actorFromContext(f.ctx)
	);
	return { status: 200, resource: response as FhirResource, headers: {} };
}

async function metadata(f: Request): Promise<GatewayResponse> {
	const from = await fhirClient.capabilityStatement({ requestId: f.ctx.requestId });
	return { status: 200, resource: enrichCapabilityStatement(from), headers: {} };
}

/** Legger SMART on FHIR-utvidelsen på HAPI sin CapabilityStatement. */
export function enrichCapabilityStatement(from: FhirResource): FhirResource {
	const tenant = requireTenant();
	const base = issuerFor(tenant);
	const rest = Array.isArray(from.rest) ? [...(from.rest as Record<string, unknown>[])] : [{ mode: 'server' }];
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
		...from,
		publisher: tenant.name,
		implementation: { description: `EPJ for fastleger - ${tenant.name}`, url: fhirBaseFor(tenant) },
		rest
	};
}

// ---------------------------------------------------------------------------
// Hjelpefunksjoner
// ---------------------------------------------------------------------------

function bodySomResource(body: unknown, expectedType: string): FhirResource {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw FhirError.invalid('Forventet en FHIR-ressurs som JSON');
	}
	const r = body as FhirResource;
	if (r.resourceType !== expectedType) {
		throw FhirError.invalid(`Forventet ${expectedType}, fikk ${r.resourceType ?? 'ukjent'}`);
	}
	return r;
}

/**
 * Merker ressursen med hvem som skrev den. HAPI fører versjonshistorikken;
 * denne taggen gjør at forfatteren også er synlig i selve ressursen, slik
 * EPJ-standarden krever for signering og kontrasignering.
 */
function withProvenance(resource: FhirResource, ctx: AuthContext): FhirResource {
	const source = ctx.clientId ? `${ctx.actorRef} via ${ctx.clientId}` : ctx.actorRef;
	return {
		...resource,
		meta: {
			...(resource.meta ?? {}),
			source: `urn:epj:${source}`,
			tag: [
				...(resource.meta?.tag ?? []).filter((t) => t.system !== 'urn:epj:forfatter'),
				{ system: 'urn:epj:forfatter', code: ctx.actorRef, display: ctx.name }
			]
		}
	};
}
