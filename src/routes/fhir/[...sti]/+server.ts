import type { RequestEvent, RequestHandler } from './$types';
import { config } from '$srv/config';
import { krevTenant, utstederFor } from '$srv/tenant/kontekst';
import { FhirError, operationOutcome, issue } from '$srv/fhir/outcome';
import { utfor } from '$srv/fhir/gateway';
import { corsHeadere } from '$srv/http';
import { listKlienter } from '$srv/auth/klienter';

/**
 * FHIR R5-endepunktet.
 *
 * Dette er journalens eneste inngang til kliniske data - både for
 * SMART-apper, backend-tjenester og journalens eget grensesnitt. Kallet
 * autoriseres og logges i `fhir/gateway.ts` før det slippes videre til
 * HAPI FHIR.
 */

const FHIR_JSON = 'application/fhir+json; charset=utf-8';

const opphavsCache = new Map<string, { verdi: string[]; til: number }>();

/** Tillatte CORS-opphav utledes fra registrerte SMART-apper sine redirect-URI-er. */
async function tillatteOpphav(): Promise<string[]> {
	// Mellomlageret er per virksomhet: apper godkjent hos én virksomhet skal
	// ikke gi CORS-tilgang hos en annen.
	const tenantId = krevTenant().id;
	const cachet = opphavsCache.get(tenantId);
	if (cachet && Date.now() < cachet.til) return cachet.verdi;
	const klienter = await listKlienter();
	const opphav = new Set<string>([new URL(utstederFor(krevTenant())).origin]);
	for (const k of klienter) {
		if (k.status !== 'aktiv') continue;
		for (const uri of k.redirect_uris) {
			try {
				opphav.add(new URL(uri).origin);
			} catch {
				/* hopp over ugyldige URI-er */
			}
		}
	}
	const verdi = [...opphav];
	opphavsCache.set(tenantId, { verdi, til: Date.now() + 60_000 });
	return verdi;
}

async function lesKropp(event: RequestEvent): Promise<unknown> {
	const type = event.request.headers.get('content-type') ?? '';
	if (event.request.method === 'GET' || event.request.method === 'DELETE') return undefined;
	if (type.includes('x-www-form-urlencoded')) {
		return new URLSearchParams(await event.request.text());
	}
	const tekst = await event.request.text();
	if (!tekst) return undefined;
	try {
		return JSON.parse(tekst);
	} catch {
		throw FhirError.ugyldig('Kroppen er ikke gyldig JSON');
	}
}

async function håndter(event: RequestEvent): Promise<Response> {
	const cors = corsHeadere(event.request.headers.get('origin'), await tillatteOpphav());
	const ctx = event.locals.auth;

	if (!ctx) {
		return new Response(JSON.stringify(operationOutcome([issue('error', 'login', 'Autentisering kreves')])), {
			status: 401,
			headers: {
				'content-type': FHIR_JSON,
				'www-authenticate': `Bearer realm="${utstederFor(krevTenant())}"`,
				...cors
			}
		});
	}

	try {
		const svar = await utfor({
			ctx,
			metode: event.request.method,
			sti: event.params.sti ?? '',
			sok: event.url.searchParams,
			kropp: await lesKropp(event),
			ifMatch: event.request.headers.get('if-match') ?? undefined,
			ifNoneExist: event.request.headers.get('if-none-exist') ?? undefined
		});
		return new Response(JSON.stringify(svar.ressurs), {
			status: svar.status,
			headers: { 'content-type': FHIR_JSON, ...svar.headers, ...cors }
		});
	} catch (err) {
		if (err instanceof FhirError) {
			return new Response(JSON.stringify(err.toOutcome()), {
				status: err.status,
				headers: {
					'content-type': FHIR_JSON,
					...(err.status === 401 ? { 'www-authenticate': `Bearer realm="${utstederFor(krevTenant())}", error="invalid_token"` } : {}),
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

export const GET: RequestHandler = håndter;
export const POST: RequestHandler = håndter;
export const PUT: RequestHandler = håndter;
export const PATCH: RequestHandler = håndter;
export const DELETE: RequestHandler = håndter;

export const OPTIONS: RequestHandler = async (event) => {
	const cors = corsHeadere(event.request.headers.get('origin'), await tillatteOpphav());
	return new Response(null, { status: 204, headers: cors });
};
