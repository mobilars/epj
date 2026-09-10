import type { RequestEvent, RequestHandler } from './$types';
import { config } from '$srv/config';
import { requireTenant, issuerFor } from '$srv/tenant/context';
import { FhirError, operationOutcome, issue } from '$srv/fhir/outcome';
import { execute } from '$srv/fhir/gateway';
import { corsHeadere } from '$srv/http';
import { listClients } from '$srv/auth/clients';

/**
 * FHIR R5-endepunktet.
 *
 * Dette er journalens eneste inngang til kliniske data - både for
 * SMART-apper, backend-tjenester og journalens eget grensesnitt. Kallet
 * autoriseres og logges i `fhir/gateway.ts` før det slippes videre til
 * HAPI FHIR.
 */

const FHIR_JSON = 'application/fhir+json; charset=utf-8';

const opphavsCache = new Map<string, { value: string[]; to: number }>();

/** Tillatte CORS-opphav utledes fra registrerte SMART-apper sine redirect-URI-er. */
async function allowedOpphav(): Promise<string[]> {
	// Mellomlageret er per virksomhet: apper godkjent hos én virksomhet skal
	// ikke gi CORS-tilgang hos en annen.
	const tenantId = requireTenant().id;
	const cached = opphavsCache.get(tenantId);
	if (cached && Date.now() < cached.to) return cached.value;
	const clients = await listClients();
	const opphav = new Set<string>([new URL(issuerFor(requireTenant())).origin]);
	for (const k of clients) {
		if (k.status !== 'aktiv') continue;
		for (const uri of k.redirect_uris) {
			try {
				opphav.add(new URL(uri).origin);
			} catch {
				/* hopp over ugyldige URI-er */
			}
		}
	}
	const value = [...opphav];
	opphavsCache.set(tenantId, { value, to: Date.now() + 60_000 });
	return value;
}

async function readBody(event: RequestEvent): Promise<unknown> {
	const type = event.request.headers.get('content-type') ?? '';
	if (event.request.method === 'GET' || event.request.method === 'DELETE') return undefined;
	if (type.includes('x-www-form-urlencoded')) {
		return new URLSearchParams(await event.request.text());
	}
	const text = await event.request.text();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		throw FhirError.invalid('Kroppen er ikke gyldig JSON');
	}
}

async function handle(event: RequestEvent): Promise<Response> {
	const cors = corsHeadere(event.request.headers.get('origin'), await allowedOpphav());
	const ctx = event.locals.auth;

	if (!ctx) {
		return new Response(JSON.stringify(operationOutcome([issue('error', 'login', 'Autentisering kreves')])), {
			status: 401,
			headers: {
				'content-type': FHIR_JSON,
				'www-authenticate': `Bearer realm="${issuerFor(requireTenant())}"`,
				...cors
			}
		});
	}

	try {
		const response = await execute({
			ctx,
			method: event.request.method,
			path: event.params.sti ?? '',
			search: event.url.searchParams,
			body: await readBody(event),
			ifMatch: event.request.headers.get('if-match') ?? undefined,
			ifNoneExist: event.request.headers.get('if-none-exist') ?? undefined
		});
		return new Response(JSON.stringify(response.resource), {
			status: response.status,
			headers: { 'content-type': FHIR_JSON, ...response.headers, ...cors }
		});
	} catch (err) {
		if (err instanceof FhirError) {
			return new Response(JSON.stringify(err.toOutcome()), {
				status: err.status,
				headers: {
					'content-type': FHIR_JSON,
					...(err.status === 401 ? { 'www-authenticate': `Bearer realm="${issuerFor(requireTenant())}", error="invalid_token"` } : {}),
					...cors
				}
			});
		}
		console.error(`[fhir] ${event.locals.requestId}`, err);
		return new Response(
			JSON.stringify(operationOutcome([issue('fatal', 'exception', `Intern feil. Referanse: ${event.locals.requestId}`)])),
			{ status: 500, headers: { 'content-type': FHIR_JSON, ...cors } }
		);
	}
}

export const GET: RequestHandler = handle;
export const POST: RequestHandler = handle;
export const PUT: RequestHandler = handle;
export const PATCH: RequestHandler = handle;
export const DELETE: RequestHandler = handle;

export const OPTIONS: RequestHandler = async (event) => {
	const cors = corsHeadere(event.request.headers.get('origin'), await allowedOpphav());
	return new Response(null, { status: 204, headers: cors });
};
