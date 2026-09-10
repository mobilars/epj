import { config } from '../config';
import { requireTenant } from '../tenant/context';
import { FhirError, issue } from './outcome';
import type { Bundle, FhirResource } from './types';

/**
 * Client for the HAPI FHIR JPA server.
 *
 * HAPI owns the clinical data: storage, version history, search indexing,
 * `$everything`, `$validate` and profile validation against the Norwegian base
 * profiles. This client is deliberately thin - all business logic and access
 * control sits in `gateway.ts`, which is the only thing that should call here.
 *
 * Every call goes to the organisation's own partition. The partition name comes
 * from the organisation context, not from the caller: no code path can then ask
 * for another organisation's data by passing the wrong name.
 */

export interface FhirRespons<T = FhirResource> {
	status: number;
	resource: T;
	etag?: string;
	location?: string;
	loadModified?: string;
}

export interface CallOpsjoner {
	/** Passed on as `X-Request-Id` to correlate the EPJ log with the HAPI log. */
	requestId?: string;
	ifMatch?: string;
	ifNoneExist?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/**
 * The base for the organisation's partition. Without partitioning the server
 * root is used, so single-organisation installations work unchanged.
 */
export function tenantBase(): string {
	const base = config.fhirServer.baseUrl;
	if (!config.fhirServer.multitenant) return base;
	return `${base}/${requireTenant().id}`;
}

function autorisasjonsHeader(): Record<string, string> {
	const { username, password } = config.fhirServer;
	if (!username) return {};
	return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

async function call(
	method: string,
	path: string,
	body?: unknown,
	options: CallOpsjoner = {}
): Promise<FhirRespons> {
	const url = path.startsWith('http') ? path : `${tenantBase()}/${path.replace(/^\//, '')}`;
	const check = new AbortController();
	const timeout = setTimeout(() => check.abort(), config.fhirServer.timeoutMs);
	options.signal?.addEventListener('abort', () => check.abort());

	let response: Response;
	try {
		response = await fetch(url, {
			method: method,
			headers: {
				accept: 'application/fhir+json',
				...(body !== undefined ? { 'content-type': 'application/fhir+json' } : {}),
				...(options.ifMatch ? { 'if-match': options.ifMatch } : {}),
				...(options.ifNoneExist ? { 'if-none-exist': options.ifNoneExist } : {}),
				...(options.requestId ? { 'x-request-id': options.requestId } : {}),
				...autorisasjonsHeader(),
				...options.headers
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: check.signal
		});
	} catch (err) {
		throw new FhirError(503, [
			issue('fatal', 'transient', `Får ikke kontakt med FHIR-serveren: ${(err as Error).message}`)
		]);
	} finally {
		clearTimeout(timeout);
	}

	const text = await response.text();
	let kropp2: unknown = undefined;
	if (text.length > 0) {
		try {
			kropp2 = JSON.parse(text);
		} catch {
			kropp2 = { resourceType: 'OperationOutcome', issue: [issue('fatal', 'exception', text.slice(0, 500))] };
		}
	}

	if (!response.ok) {
		const outcome = kropp2 as { resourceType?: string; issue?: unknown[] } | undefined;
		const issues = outcome?.resourceType === 'OperationOutcome' && Array.isArray(outcome.issue)
			? (outcome.issue as never[])
			: [issue('error', 'processing', `FHIR-serveren svarte ${response.status}`)];
		throw new FhirError(response.status, issues);
	}

	return {
		status: response.status,
		resource: (kropp2 ?? {}) as FhirResource,
		etag: response.headers.get('etag') ?? undefined,
		location: response.headers.get('location') ?? undefined,
		loadModified: response.headers.get('last-modified') ?? undefined
	};
}

export const fhirClient = {
	async read(resourceType: string, id: string, o?: CallOpsjoner): Promise<FhirResource> {
		return (await call('GET', `${resourceType}/${encodeURIComponent(id)}`, undefined, o)).resource;
	},

	async readVersion(resourceType: string, id: string, versionId: string, o?: CallOpsjoner): Promise<FhirResource> {
		return (await call('GET', `${resourceType}/${encodeURIComponent(id)}/_history/${encodeURIComponent(versionId)}`, undefined, o)).resource;
	},

	async history(resourceType: string, id: string, query = new URLSearchParams(), o?: CallOpsjoner): Promise<Bundle> {
		const qs = query.toString();
		return (await call('GET', `${resourceType}/${encodeURIComponent(id)}/_history${qs ? `?${qs}` : ''}`, undefined, o)).resource as Bundle;
	},

	async search(resourceType: string, query: URLSearchParams, o?: CallOpsjoner): Promise<Bundle> {
		// POST to /_search is used rather than GET, so that patient identifiers do
		// not end up in URLs and thereby in intermediate access logs.
		return this.searchPost(resourceType, query, o);
	},

	/** Search with POST and a form-encoded body (preferred for patient searches). */
	async searchPost(resourceType: string, query: URLSearchParams, o?: CallOpsjoner): Promise<Bundle> {
		const url = `${tenantBase()}/${resourceType}/_search`;
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/fhir+json',
				'content-type': 'application/x-www-form-urlencoded',
				...(o?.requestId ? { 'x-request-id': o.requestId } : {}),
				...autorisasjonsHeader()
			},
			body: query.toString(),
			signal: o?.signal
		});
		const text = await response.text();
		const body = text ? JSON.parse(text) : {};
		if (!response.ok) {
			throw new FhirError(response.status, (body as { issue?: never[] }).issue ?? [issue('error', 'processing', `FHIR-serveren svarte ${response.status}`)]);
		}
		return body as Bundle;
	},

	async create(resource: FhirResource, o?: CallOpsjoner): Promise<FhirRespons> {
		return call('POST', resource.resourceType, resource, o);
	},

	async update(resourceType: string, id: string, resource: FhirResource, o?: CallOpsjoner): Promise<FhirRespons> {
		return call('PUT', `${resourceType}/${encodeURIComponent(id)}`, { ...resource, resourceType, id }, o);
	},

	async patch(resourceType: string, id: string, patch: unknown[], o?: CallOpsjoner): Promise<FhirRespons> {
		return call('PATCH', `${resourceType}/${encodeURIComponent(id)}`, patch, {
			...o,
			headers: { ...o?.headers, 'content-type': 'application/json-patch+json' }
		});
	},

	async deleteValue(resourceType: string, id: string, o?: CallOpsjoner): Promise<FhirRespons> {
		return call('DELETE', `${resourceType}/${encodeURIComponent(id)}`, undefined, o);
	},

	async transaction(bundle: Bundle, o?: CallOpsjoner): Promise<Bundle> {
		return (await call('POST', '', bundle, o)).resource as Bundle;
	},

	async operation(path: string, parametre?: FhirResource, o?: CallOpsjoner): Promise<FhirResource> {
		return (await call(parametre ? 'POST' : 'GET', path, parametre, o)).resource;
	},

	/** The patient's complete record. HAPI implements $everything with paging. */
	async everything(patientId: string, query = new URLSearchParams(), o?: CallOpsjoner): Promise<Bundle> {
		const qs = query.toString();
		return (await call('GET', `Patient/${encodeURIComponent(patientId)}/$everything${qs ? `?${qs}` : ''}`, undefined, o)).resource as Bundle;
	},

	async validate(resource: FhirResource, profil?: string, o?: CallOpsjoner): Promise<FhirResource> {
		const path = `${resource.resourceType}/$validate${profil ? `?profile=${encodeURIComponent(profil)}` : ''}`;
		try {
			return (await call('POST', path, resource, o)).resource;
		} catch (err) {
			if (err instanceof FhirError) return err.toOutcome();
			throw err;
		}
	},

	async capabilityStatement(o?: CallOpsjoner): Promise<FhirResource> {
		return (await call('GET', 'metadata', undefined, o)).resource;
	},

	/** Simple health check used by /api/helse and the startup sequence. */
	async isTilgjengelig(): Promise<boolean> {
		try {
			await call('GET', 'metadata?_summary=true');
			return true;
		} catch {
			return false;
		}
	}
};
