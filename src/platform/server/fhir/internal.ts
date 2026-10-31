import { error } from '@sveltejs/kit';
import { execute } from './gateway';
import { FhirError } from './outcome';
import type { AuthContext } from '../authz/context';
import type { Bundle, FhirResource } from './types';

/**
 * The record's own UI talks to FHIR through exactly the same guard as external
 * apps. There is no back door around access control and logging - a mistake in
 * the UI code cannot give more insight than the API gives.
 */

export async function readResource(ctx: AuthContext, resourceType: string, id: string): Promise<FhirResource> {
	try {
		const response = await execute({ ctx, method: 'GET', path: `${resourceType}/${id}`, search: new URLSearchParams() });
		return response.resource;
	} catch (err) {
		throw toKitError(err);
	}
}

export async function readResourceHvisExists(
	ctx: AuthContext,
	resourceType: string,
	id: string
): Promise<FhirResource | null> {
	try {
		const response = await execute({ ctx, method: 'GET', path: `${resourceType}/${id}`, search: new URLSearchParams() });
		return response.resource;
	} catch {
		return null;
	}
}

export async function searchResources(
	ctx: AuthContext,
	resourceType: string,
	search: Record<string, string | number | undefined> | URLSearchParams
): Promise<Bundle> {
	const params = search instanceof URLSearchParams ? search : new URLSearchParams(
		Object.entries(search)
			.filter(([, v]) => v !== undefined && v !== '')
			.map(([k, v]) => [k, String(v)])
	);
	try {
		const response = await execute({ ctx, method: 'POST', path: `${resourceType}/_search`, search: new URLSearchParams(), body: params });
		return response.resource as Bundle;
	} catch (err) {
		throw toKitError(err);
	}
}

export async function writeResource(
	ctx: AuthContext,
	resource: FhirResource,
	id?: string
): Promise<FhirResource> {
	try {
		const response = id
			? await execute({ ctx, method: 'PUT', path: `${resource.resourceType}/${id}`, search: new URLSearchParams(), body: { ...resource, id } })
			: await execute({ ctx, method: 'POST', path: resource.resourceType, search: new URLSearchParams(), body: resource });
		return response.resource;
	} catch (err) {
		throw toKitError(err);
	}
}

export async function patientRecord(ctx: AuthContext, patientId: string, count = 200): Promise<Bundle> {
	const response = await execute({
		ctx, method: 'GET', path: `Patient/${patientId}/$everything`,
		search: new URLSearchParams({ _count: String(count) })
	});
	return response.resource as Bundle;
}

/** Pulls the resources out of a search Bundle. */
export function resources(bundle: Bundle): FhirResource[] {
	return (bundle.entry ?? []).map((e) => e.resource).filter(Boolean) as FhirResource[];
}

function toKitError(err: unknown): never {
	if (err instanceof FhirError) {
		error(err.status === 401 ? 401 : err.status === 403 ? 403 : err.status === 404 ? 404 : 500, {
			message: err.issues[0]?.diagnostics ?? 'FHIR-feil',
			code: err.issues[0]?.code
		});
	}
	throw err;
}
