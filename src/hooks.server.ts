import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { config } from '$srv/config';
import { clientIp, rateLimit, securityHeaders } from '$srv/http';
import { getSession } from '$srv/auth/session';
import { getUser, rolesFor } from '$srv/auth/users';
import { validateAccessToken } from '$srv/auth/tokens';
import { parseScopes } from '$srv/authz/scopes';
import { permissionsForRoles, scopesForRoles } from '$srv/authz/roles';
import type { AuthContext } from '$srv/authz/context';
import { migrate } from '$srv/db/migrate';
import { log } from '$srv/audit';
import { withTenant, PLATFORM_TENANT, type Tenant } from '$srv/tenant/context';
import { getTenant, getTenantOnHostname, ensureDefaultOrganisation } from '$srv/tenant/tenant';

let migrertOk: Promise<unknown> | null = null;

/** Kjører migrasjoner én gang ved oppstart. */
function ensureSchema(): Promise<unknown> {
	if (!migrertOk) {
		migrertOk = migrate()
			.then(() => ensureDefaultOrganisation())
			.catch((err) => {
				console.error('[oppstart] migrering feilet', err);
				migrertOk = null;
				throw err;
			});
	}
	return migrertOk;
}

/** Bygger tilgangskontekst for en innlogget sesjon i journalens eget grensesnitt. */
async function contextFromSession(event: Parameters<Handle>[0]['event'], requestId: string): Promise<AuthContext | null> {
	const session = await getSession(event.cookies);
	if (!session) return null;
	const user = await getUser(session.user_id);
	if (!user || user.status !== 'aktiv') return null;
	const roles = await rolesFor(user.id);
	return {
		mate: 'session',
		userId: user.id,
		actorRef: user.practitioner_id ? `Practitioner/${user.practitioner_id}` : `Person/${user.id}`,
		name: user.name,
		roles,
		permissions: permissionsForRoles(roles),
		// Journalens eget grensesnitt får alle scopes rollen tillater.
		scopes: parseScopes([...scopesForRoles(roles)].join(' ')),
		clientId: null,
		clientName: 'EPJ',
		launch: {},
		sessionId: session.id,
		tokenId: null,
		amr: session.amr ?? 'pwd',
		elevatedTo: session.elevated_until,
		ip: clientIp(event),
		requestId
	};
}

async function contextFromBearer(authorization: string, event: Parameters<Handle>[0]['event'], requestId: string): Promise<AuthContext | null> {
	const token = authorization.slice(7).trim();
	const result = await validateAccessToken(token);
	if (!result.valid || !result.ctx) return null;
	return { ...result.ctx, ip: clientIp(event), requestId };
}

/**
 * Finner hvilken virksomhet forespørselen gjelder.
 *
 * Utledes av vertsnavnet, aldri av noe klienten kan velge. Ukjent vertsnavn
 * avvises i produksjon; i utvikling faller vi tilbake på standardvirksomheten,
 * slik at localhost virker uten oppsett.
 */
async function resolveTenant(hostname: string): Promise<{ tenant: Tenant; isPlatform: boolean } | { error: string; status: number }> {
	if (config.tenant.platformHostname && hostname === config.tenant.platformHostname) {
		const platform = await getTenant(PLATFORM_TENANT);
		if (!platform) return { error: 'Plattformvirksomheten mangler', status: 500 };
		return { tenant: platform, isPlatform: true };
	}

	const funnet = await getTenantOnHostname(hostname);
	if (funnet) {
		if (funnet.status !== 'aktiv') {
			return { error: `Virksomheten er ${funnet.status}. Kontakt leverandøren.`, status: 503 };
		}
		return { tenant: funnet, isPlatform: false };
	}

	if (!config.tenant.allowUnknownHostname) {
		return { error: `Ukjent vertsnavn: ${hostname}`, status: 404 };
	}
	const defaultValue = await getTenant(config.tenant.defaultValue);
	if (!defaultValue) return { error: 'Standardvirksomheten mangler. Kjør migrasjonene.', status: 500 };
	return { tenant: defaultValue, isPlatform: false };
}

export const handle: Handle = async ({ event, resolve }) => {
	await ensureSchema();

	const resolution = await resolveTenant(event.url.hostname);
	if ('error' in resolution) {
		return new Response(resolution.error, { status: resolution.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	event.locals.tenant = resolution.tenant;
	event.locals.isPlatform = resolution.isPlatform;

	// Resten av forespørselen kjører i virksomhetens kontekst. Spørringer som
	// glemmer avgrensningen feiler dermed høylytt i stedet for å hente andres data.
	return withTenant(resolution.tenant, () => handleIContext(event, resolve, resolution.isPlatform));
};

async function handleIContext(
	event: Parameters<Handle>[0]['event'],
	resolve: Parameters<Handle>[0]['resolve'],
	isPlatform: boolean
): Promise<Response> {
	const requestId = event.request.headers.get('x-request-id') ?? randomUUID();
	event.locals.requestId = requestId;
	event.locals.clientIp = clientIp(event);
	event.locals.auth = null;

	const path = event.url.pathname;
	const isFhirApi = path.startsWith('/fhir') || path.startsWith('/api') || path.startsWith('/oauth');

	// Plattformadministrasjonen nås bare på plattformens eget vertsnavn, og
	// virksomhetens sider nås ikke derfra.
	if (config.tenant.platformHostname) {
		if (path.startsWith('/systemadmin') && !isPlatform) {
			return new Response('Plattformadministrasjon nås på et eget vertsnavn.', { status: 404 });
		}
		if (isPlatform && !path.startsWith('/systemadmin') && !path.startsWith('/logg-inn') && !path.startsWith('/logg-ut') && path !== '/') {
			return new Response('Denne adressen er forbeholdt plattformadministrasjon.', { status: 404 });
		}
	}

	// Ratebegrensning. Autentiseringsendepunktene er strengere enn resten.
	const strengt = path.startsWith('/oauth/token') || path === '/logg-inn';
	const limit = await rateLimit(
		`${strengt ? 'auth' : 'alm'}:${event.locals.clientIp}`,
		strengt ? config.security.rateLimit.autentiseringPerMinutt : config.security.rateLimit.generellPerMinutt,
		60
	);
	if (!limit.allowed) {
		return new Response(
			JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'throttled', diagnostics: 'For mange forespørsler' }] }),
			{ status: 429, headers: { 'content-type': 'application/fhir+json', 'retry-after': String(limit.nullstillesAbout) } }
		);
	}

	const authorization = event.request.headers.get('authorization');
	if (authorization?.toLowerCase().startsWith('bearer ')) {
		event.locals.auth = await contextFromBearer(authorization, event, requestId);
		if (!event.locals.auth && path.startsWith('/fhir')) {
			await log(
				{ type: 'security-alert', subtype: 'token-avvist', action: 'E', outcome: '4', outcomeDescription: 'Ugyldig eller utløpt access token', entityRef: path },
				{ userId: null, actorRef: 'Device/ukjent', name: 'ukjent', role: null, clientId: null, ip: event.locals.clientIp, requestId }
			).catch(() => undefined);
			return new Response(
				JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Ugyldig eller utløpt token' }] }),
				{
					status: 401,
					headers: {
						'content-type': 'application/fhir+json',
						'www-authenticate': `Bearer realm="${event.locals.tenant.base_url}", error="invalid_token"`
					}
				}
			);
		}
	} else {
		event.locals.auth = await contextFromSession(event, requestId);
	}

	const response = await resolve(event);

	for (const [k, v] of Object.entries(securityHeaders(isFhirApi))) {
		response.headers.set(k, v);
	}
	response.headers.set('x-request-id', requestId);
	return response;
}

export const handleError: HandleServerError = ({ error, event }) => {
	const requestId = event.locals?.requestId ?? 'ukjent';
	// Detaljer logges på serveren; klienten får bare en korrelasjons-id, slik at
	// interne feilmeldinger ikke lekker informasjon om systemet.
	console.error(`[feil] ${requestId} ${event.url.pathname}`, error);
	return {
		message: 'Det oppsto en uventet feil. Kontakt systemansvarlig og oppgi referansen.',
		code: 'intern_feil',
		requestId
	};
};
