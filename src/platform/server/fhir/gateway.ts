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
import { binaryOwner, forgetBinaryOwner, rememberBinaryOwner } from './binary';
import { normaliseFromR4 } from './r4';
import { codeSystemOperation, valueSetOperation, icpc2CodeSystemResource } from '../terminology/operations';
import { ICPC2 } from '../terminology/icpc2';

/**
 * The guard in front of HAPI FHIR.
 *
 * Every FHIR call - from the record's own UI, from SMART apps and from backend
 * services - goes through this module. Here, and only here, we enforce:
 *
 *  - SMART scope and role (`authz/access.ts`)
 *  - legitimate need: searches are narrowed to patients the user relates to
 *  - restriction: patients who have blocked the record are filtered out
 *  - audit log: every call yields an AuditEvent, refused ones included
 *
 * HAPI itself is not exposed. If someone reaches HAPI directly over the
 * network, that is a breach of the network design, not a bypass of this code.
 */

export interface GatewayResponse {
	status: number;
	resource: FhirResource;
	headers: Record<string, string>;
}

const METHOD_TO_OPERATION: Record<string, Operation> = {
	GET: 'r', HEAD: 'r', POST: 'c', PUT: 'u', PATCH: 'u', DELETE: 'd'
};

/**
 * The patient a request concerns.
 *
 * Every resource but one says so itself. `Binary` has no `subject`, so the link
 * recorded when the attachment was created is looked up instead - and an
 * attachment nothing has claimed belongs to nobody, which denies it to
 * everybody.
 */
async function patientForResource(resourceType: string, resource: FhirResource | null, id?: string): Promise<string | null> {
	if (resourceType !== 'Binary') return resource ? patientIdFromResource(resource) : null;
	return id ? await binaryOwner(id) : null;
}

/**
 * The patient an attachment being created belongs to.
 *
 * `Binary.securityContext` is the FHIR way of saying it, and is used when the
 * app sets it. Apps generally do not - the attachment is posted first and the
 * DocumentReference that names the patient only afterwards - so the patient in
 * the launch context is what is left, and it is the right answer: the app was
 * started on that patient and is writing about them.
 */
function patientForNewBinary(resource: FhirResource, ctx: AuthContext): string | null {
	const securityContext = (resource as unknown as { securityContext?: { reference?: string } }).securityContext;
	const ref = securityContext?.reference;
	if (typeof ref === 'string' && ref.startsWith('Patient/')) return ref.slice('Patient/'.length);
	return ctx.launch.patientId ?? null;
}

/** Search parameters used to narrow by patient, per resource type. */
function patientParam(resourceType: string): string | null {
	if (resourceType === 'Patient') return '_id';
	const candidates = PATIENTCOMPARTMENT[resourceType] ?? [];
	return candidates.includes('patient') ? 'patient' : (candidates[0] ?? null);
}

export interface Request {
	ctx: AuthContext;
	method: string;
	/** Path under /fhir, e.g. `Patient/123` or `Observation/_search`. */
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

	// Terminology is answered from the bundled tables, not from HAPI, and it
	// concerns no patient: a signed-in caller is all that is required. See
	// terminology/operations.ts.
	if (resourceType === 'CodeSystem' || resourceType === 'ValueSet') {
		if (parts.length === 2 && parts[1].startsWith('$')) {
			const answer = resourceType === 'CodeSystem' ? codeSystemOperation(parts[1], f.search) : valueSetOperation(parts[1], f.search);
			return { ...answer, headers: {} };
		}
		if (resourceType === 'CodeSystem' && parts.length === 1 && f.method === 'GET') {
			const url = f.search.get('url');
			const all = !url || url === ICPC2.url ? [icpc2CodeSystemResource()] : [];
			return { status: 200, resource: { resourceType: 'Bundle', type: 'searchset', total: all.length, entry: all.map((r) => ({ resource: r })) } as FhirResource, headers: {} };
		}
		if (resourceType === 'CodeSystem' && parts.length === 2 && parts[1] === 'icpc-2' && f.method === 'GET') {
			return { status: 200, resource: icpc2CodeSystemResource(), headers: {} };
		}
		throw FhirError.notStottet(`${f.method} ${f.path} er ikke tilgjengelig. Terminologi svares på $lookup, $validate-code og $expand.`);
	}

	if (!SEARCH_PARAMS[resourceType]) {
		throw FhirError.notStottet(`Ressurstypen ${resourceType} er ikke støttet`);
	}

	// [type]/_search  and  [type]?...  -> search
	if ((parts.length === 2 && parts[1] === '_search') || parts.length === 1) {
		if (f.method === 'POST' && parts.length === 1) return createResource(f, resourceType);
		// Searching attachments would list every one in the practice: the type has
		// no patient of its own to narrow by, so there is nothing to filter on.
		// They are reached by id, from the DocumentReference pointing at them.
		if (resourceType === 'Binary') throw FhirError.notStottet('Søk i Binary er ikke tilgjengelig. Hent vedlegget med id fra DocumentReference.');
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
	const patientId = await patientForResource(resourceType, resource, id);
	if (resourceType === 'Binary' && !patientId) {
		await log(
			{ type: 'rest', subtype: 'read', action: 'R', outcome: '4', outcomeDescription: 'Vedlegget er ikke knyttet til en pasient', entityRef: `Binary/${id}` },
			actorFromContext(f.ctx)
		);
		throw new FhirError(403, [issue('error', 'forbidden', 'Vedlegget er ikke knyttet til en pasient, og kan ikke utleveres.')]);
	}
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
	const patientId = await patientForResource(resourceType, resource, id);
	if (resourceType === 'Binary' && !patientId) {
		throw new FhirError(403, [issue('error', 'forbidden', 'Vedlegget er ikke knyttet til en pasient, og kan ikke utleveres.')]);
	}
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'r', resource, patientId });
	await log(
		{ type: 'rest', subtype: 'vread', action: 'R', outcome: decision.allowed ? '0' : '4', patientId, entityRef: `${resourceType}/${id}/_history/${versionId}`, purposeOfUse: decision.purposeOfUse },
		actorFromContext(f.ctx)
	);
	if (!decision.allowed) throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	return { status: 200, resource, headers: {} };
}

async function createResource(f: Request, resourceType: string): Promise<GatewayResponse> {
	const resource = normaliseFromR4(bodySomResource(f.body, resourceType));
	const findings = validate(resource, resourceType).filter((i) => i.severity === 'error' || i.severity === 'fatal');
	if (findings.length > 0) throw new FhirError(422, findings);

	const patientId =
		resourceType === 'Binary' ? patientForNewBinary(resource, f.ctx) : patientIdFromResource(resource);
	if (resourceType === 'Binary' && !patientId) {
		await log(
			{ type: 'rest', subtype: 'create', action: 'C', outcome: '4', outcomeDescription: 'Vedlegg krever pasient i kontekst', entityRef: 'Binary' },
			actorFromContext(f.ctx)
		);
		throw new FhirError(422, [
			issue('error', 'invariant', 'Et vedlegg må knyttes til en pasient. Start appen med pasient i kontekst, eller sett Binary.securityContext til pasienten.')
		]);
	}
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'c', resource, patientId });
	if (!decision.allowed) {
		await log({ type: 'rest', subtype: 'create', action: 'C', outcome: '4', outcomeDescription: decision.reason, patientId, entityRef: resourceType, purposeOfUse: decision.purposeOfUse }, actorFromContext(f.ctx));
		throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	}

	const response = await fhirClient.create(withProvenance(resource, f.ctx), {
		requestId: f.ctx.requestId,
		ifNoneExist: f.ifNoneExist
	});
	// Recorded before the call returns to the app, so an attachment is never
	// readable in the window between being stored and being claimed.
	if (resourceType === 'Binary' && patientId && response.resource.id) {
		await rememberBinaryOwner(response.resource.id as string, patientId, f.ctx.userId);
	}
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
	const newValue = normaliseFromR4(bodySomResource(f.body, resourceType));
	const findings = validate({ ...newValue, id }, resourceType).filter((i) => i.severity === 'error' || i.severity === 'fatal');
	if (findings.length > 0) throw new FhirError(422, findings);

	// Access must be judged against both the new and the existing version: a user
	// must not be able to move a resource onto "their" patient.
	const existing = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId }).catch(() => null);
	// An attachment is judged against whoever owns it, and against the patient it
	// would be given to, so it cannot be moved onto another patient's record.
	const binaryPatient =
		resourceType === 'Binary' ? (await binaryOwner(id)) ?? patientForNewBinary(newValue, f.ctx) : null;
	if (resourceType === 'Binary' && !binaryPatient) {
		throw new FhirError(422, [
			issue('error', 'invariant', 'Et vedlegg må knyttes til en pasient. Start appen med pasient i kontekst, eller sett Binary.securityContext til pasienten.')
		]);
	}
	for (const candidate of [newValue, existing].filter(Boolean) as FhirResource[]) {
		const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'u', resource: candidate, patientId: binaryPatient ?? patientIdFromResource(candidate) });
		if (!decision.allowed) {
			await log({ type: 'rest', subtype: 'update', action: 'U', outcome: '4', outcomeDescription: decision.reason, patientId: patientIdFromResource(candidate), entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse }, actorFromContext(f.ctx));
			throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
		}
	}

	const response = await fhirClient.update(resourceType, id, withProvenance(newValue, f.ctx), {
		requestId: f.ctx.requestId,
		ifMatch: f.ifMatch
	});
	if (resourceType === 'Binary' && binaryPatient) {
		await rememberBinaryOwner(id, binaryPatient, f.ctx.userId);
	}
	await log(
		{ type: 'rest', subtype: 'update', action: 'U', outcome: '0', patientId: patientIdFromResource(newValue), entityRef: `${resourceType}/${id}`, purposeOfUse: 'TREAT' },
		actorFromContext(f.ctx)
	);
	return { status: response.status, resource: response.resource, headers: response.etag ? { etag: response.etag } : {} };
}

async function patchResource(f: Request, resourceType: string, id: string): Promise<GatewayResponse> {
	const existing = await fhirClient.read(resourceType, id, { requestId: f.ctx.requestId });
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'u', resource: existing, patientId: patientIdFromResource(existing) });
	if (!decision.allowed) {
		await log({ type: 'rest', subtype: 'patch', action: 'U', outcome: '4', outcomeDescription: decision.reason, patientId: patientIdFromResource(existing), entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse }, actorFromContext(f.ctx));
		throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	}
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
	const patientId = await patientForResource(resourceType, existing, id);
	const decision = await evaluate({ ctx: f.ctx, resourceType, operation: 'd', resource: existing, patientId, resourceId: id });
	if (!decision.allowed) {
		await log({ type: 'rest', subtype: 'delete', action: 'D', outcome: '4', outcomeDescription: decision.reason, patientId, entityRef: `${resourceType}/${id}` }, actorFromContext(f.ctx));
		throw new FhirError(decision.status, [issue('error', 'forbidden', decision.reason ?? 'Ingen tilgang')]);
	}
	// Record content should not be deleted without a decision; marking it
	// entered-in-error is the main route. Deleting here removes the resource from
	// search, while HAPI keeps the version history.
	const response = await fhirClient.deleteValue(resourceType, id, { requestId: f.ctx.requestId });
	if (resourceType === 'Binary') await forgetBinaryOwner(id);
	await log(
		{ type: 'rest', subtype: 'delete', action: 'D', outcome: '0', patientId, entityRef: `${resourceType}/${id}`, purposeOfUse: decision.purposeOfUse },
		actorFromContext(f.ctx)
	);
	return { status: response.status === 204 ? 200 : response.status, resource: response.resource ?? { resourceType: 'OperationOutcome', issue: [issue('information', 'informational', 'Slettet')] }, headers: {} };
}

// ---------------------------------------------------------------------------
// Search
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

	// Forces in scope limitations, e.g. `patient/Observation.rs?category=vital-signs`.
	for (const limitation of decision.limitations) {
		for (const [k, v] of limitation) search.append(k, v);
	}

	// Narrowing to the patients the user actually has a legitimate need for.
	const allowed = await allowedPatients(f.ctx);
	const param = patientParam(resourceType);
	if (allowed !== 'alle') {
		// With no parameter to narrow on, the query would go unfiltered to HAPI and
		// return the organisation's entire data for that type. `evaluate` should
		// already have refused such types; this is the second lock on the same door.
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

	// Post-filter for restrictions. A restriction can change between two calls,
	// and HAPI does not know the restriction model, so the filter is applied here.
	//
	// The same pass keeps included resources (`_include`, `_revinclude`) to the
	// patients the user may see. The `patient=` narrowing above covers the type
	// being searched; what is pulled in alongside can point at another patient
	// - a Composition entry, a ServiceRequest a Communication is based on - and
	// gets the same test per entry.
	const blocked = await blockedPatients(f.ctx);
	const allowedSet = allowed === 'alle' ? null : new Set(allowed);
	const kept = (bundle.entry ?? []).filter((e) => {
		if (!e.resource) return true;
		const p = patientIdFromResource(e.resource);
		if (!p) return true;
		if (blocked.has(p)) return false;
		return !allowedSet || allowedSet.has(p);
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

/** Removes identifiers from the query before it is written to the log. */
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
// History, operations and transactions
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

/** Removes resource types the app has no read scope for from a collected bundle. */
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

	// Each entry is judged on its own. A transaction must not become a way to
	// bypass access control by wrapping up calls the user is not allowed to make.
	for (const entry of bundle.entry ?? []) {
		const method = entry.request?.method ?? 'POST';
		const url = entry.request?.url ?? '';
		const resourceType = entry.resource?.resourceType ?? url.split('/')[0].split('?')[0];
		if (!resourceType) throw FhirError.invalid('Oppføring i Bundle mangler ressurstype');
		const operation = METHOD_TO_OPERATION[method] ?? 'r';
		const refuse = async (reason: string, status: 403 | 400 = 403) => {
			await log({ type: 'rest', subtype: 'transaction', action: 'E', outcome: '4', outcomeDescription: reason, entityRef: `${method} ${url}` }, actorFromContext(f.ctx));
			throw new FhirError(status, [issue('error', status === 403 ? 'forbidden' : 'not-supported', `${method} ${url}: ${reason}`)]);
		};

		/*
		 * An attachment is claimed for a patient as it is written, and the claim
		 * is what makes it readable afterwards. Inside a bundle the ids are
		 * assigned by the server in one go, so there is no safe moment to record
		 * the claim - and an attachment nobody has claimed can be read by nobody.
		 * Refused rather than quietly written and lost: post it on its own first,
		 * then refer to it from the DocumentReference.
		 */
		if (resourceType === 'Binary') {
			await refuse('Vedlegg må håndteres for seg, ikke i en Bundle. Post Binary først, og pek på det fra DocumentReference.', 400);
		}

		const candidates: { resource: FhirResource | null; patientId: string | null }[] = [
			{ resource: entry.resource ?? null, patientId: entry.resource ? patientIdFromResource(entry.resource) : null }
		];

		/**
		 * A change to something that exists is judged against the stored version
		 * too, exactly as a plain PUT is: otherwise a bundle could move another
		 * patient's resource onto a patient the user does see. Conditional forms
		 * (`Type?identifier=...`) have no single stored version to judge, and
		 * are refused rather than guessed at.
		 */
		if (operation === 'u' || operation === 'd') {
			const m = /^([A-Za-z]+)\/([A-Za-z0-9.-]+)$/.exec(url.split('?')[0]);
			if (!m || url.includes('?')) await refuse('Betingede endringer i en Bundle støttes ikke', 400);
			const existing = await fhirClient.read(m![1], m![2], { requestId: f.ctx.requestId }).catch(() => null);
			if (existing) candidates.push({ resource: existing, patientId: patientIdFromResource(existing) });
		}

		for (const c of candidates) {
			const decision = await evaluate({ ctx: f.ctx, resourceType, operation, resource: c.resource, patientId: c.patientId });
			if (!decision.allowed) await refuse(decision.reason ?? 'Ingen tilgang');
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

/** Adds the SMART on FHIR extension to HAPI's CapabilityStatement. */
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
 * Tags the resource with who wrote it. HAPI keeps the version history; this tag
 * makes the author visible in the resource itself as well, as the EPJ standard
 * requires for signing and countersigning.
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
