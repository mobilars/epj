import { redirect } from '@sveltejs/kit';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { config } from '$srv/config';
import { clientIp, rateLimit, securityHeaders } from '$srv/http';
import { getSession, tenantIdForSession } from '$srv/auth/session';
import { methodIsEnough } from '$srv/auth/login-level';
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

/** Runs migrations once at startup. */
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

/** Builds the auth context for a signed-in session in the record's own UI. */
async function contextFromSession(event: Parameters<Handle>[0]['event'], requestId: string): Promise<AuthContext | null> {
	const session = await getSession(event.cookies);
	if (!session) return null;

	/**
	 * A session is only as good as the way it was established.
	 *
	 * If the organisation has since raised what it requires, a session signed in
	 * the old way stops working now rather than at the next sign-out. Otherwise
	 * tightening the setting would change nothing for anyone already inside,
	 * which is exactly the population it was tightened for.
	 */
	if (!methodIsEnough(session.amr ?? '', event.locals.tenant.login_level)) return null;

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
		// The record's own UI gets every scope the role permits.
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
 * Finds which organisation a request concerns.
 *
 * Derived from the hostname, never from anything the client can choose. An
 * unknown hostname is refused in production; in development we fall back to the
 * default organisation, so localhost works without setup.
 */
async function resolveTenant(
	hostname: string,
	sessionTenantId?: string | null
): Promise<{ tenant: Tenant; isPlatform: boolean } | { error: string; status: number }> {
	const funnet = await getTenantOnHostname(hostname);
	if (funnet) {
		if (funnet.status !== 'aktiv') {
			return { error: `Virksomheten er ${funnet.status}. Kontakt leverandøren.`, status: 503 };
		}
		return { tenant: funnet, isPlatform: funnet.id === PLATFORM_TENANT };
	}

	if (!config.tenant.allowUnknownHostname) {
		return { error: `Ukjent vertsnavn: ${hostname}`, status: 404 };
	}

	/**
	 * A hostname no organisation has claimed is a shared one, and the
	 * organisation then follows from who is signed in.
	 *
	 * Giving every practice an address of its own needs a certificate for every
	 * name, and this installation has no wildcard certificate - so an
	 * organisation created with a hostname nobody added would simply not answer.
	 * Sharing one address is the honest default; a practice that wants its own
	 * gets one added deliberately, and is then found by hostname above.
	 *
	 * The isolation is unchanged. The id comes from the session, which is
	 * server-side and cannot be named by the client, and the session is verified
	 * inside that organisation exactly as it is on a dedicated hostname.
	 */
	if (sessionTenantId) {
		const theirs = await getTenant(sessionTenantId);
		if (theirs && theirs.status === 'aktiv') return { tenant: theirs, isPlatform: false };
	}

	const defaultValue = await getTenant(config.tenant.defaultValue);
	if (!defaultValue) return { error: 'Standardvirksomheten mangler. Kjør migrasjonene.', status: 500 };
	return { tenant: defaultValue, isPlatform: false };
}

export const handle: Handle = async ({ event, resolve }) => {
	await ensureSchema();

	// On a shared hostname the organisation comes from the session, so it has to
	// be looked up before the organisation context exists. Not on the platform's
	// own hostname, which belongs to one organisation by definition.
	const sessionTenant =
		config.tenant.platformHostname && event.url.hostname === config.tenant.platformHostname
			? null
			: await tenantIdForSession(event.cookies);
	const resolution = await resolveTenant(event.url.hostname, sessionTenant);
	if ('error' in resolution) {
		return new Response(resolution.error, { status: resolution.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	event.locals.tenant = resolution.tenant;
	event.locals.isPlatform = resolution.isPlatform;

	// The rest of the request runs in the organisation's context. Queries that
	// forget the boundary then fail loudly instead of fetching someone else's data.
	return withTenant(resolution.tenant, () => handleIContext(event, resolve, resolution.isPlatform));
};

async function handleIContext(
	event: Parameters<Handle>[0]['event'],
	resolve: Parameters<Handle>[0]['resolve'],
	isPlatform: boolean
): Promise<Response> {
	// A caller may supply the correlation id, so that its own logs and ours
	// line up - but it ends up in the audit log verbatim, so only a plain token
	// is accepted. Anything else gets an id of our own.
	const supplied = event.request.headers.get('x-request-id') ?? '';
	const requestId = /^[A-Za-z0-9._-]{8,64}$/.test(supplied) ? supplied : randomUUID();
	event.locals.requestId = requestId;
	event.locals.clientIp = clientIp(event);
	event.locals.auth = null;

	const path = event.url.pathname;
	/**
	 * API responses get a minimal policy, because nothing renders them as HTML.
	 *
	 * The consent dialog is the exception under /oauth: it is a page a person
	 * reads and presses a button on, and it has to render inside the frame an
	 * embedded app runs in. Treating it as an API response gave it
	 * `default-src 'none'` and no framing, and the app never got past consent.
	 */
	// The pages under /oauth that a person actually looks at. Everything else
	// there answers a machine.
	const oauthPages = ['/oauth/authorize', '/oauth/videresend'];
	// CDS Hooks answers machines, like the FHIR endpoint does.
	const isCds = path.startsWith('/cds-services');
	const isFhirApi =
		isCds ||
		((path.startsWith('/fhir') || path.startsWith('/api') || path.startsWith('/oauth')) &&
			!oauthPages.some((p) => path.startsWith(p)));

	/**
	 * The developer portal has a hostname of its own, and only the portal is on
	 * it.
	 *
	 * A developer account holds no role and no organisation, and the portal
	 * shows nothing about patients. Separating them by hostname means a
	 * developer session cannot reach a record page even if something later goes
	 * wrong with the checks inside the pages themselves.
	 */
	const isDeveloperPortal =
		Boolean(config.tenant.developerHostname) && event.url.hostname === config.tenant.developerHostname;
	if (config.tenant.developerHostname) {
		if (path.startsWith('/utvikler') && !isDeveloperPortal) {
			return new Response('Utviklerportalen nås på et eget vertsnavn.', { status: 404 });
		}
		if (isDeveloperPortal && !path.startsWith('/utvikler') && path !== '/') {
			return new Response('Denne adressen er forbeholdt utviklerportalen.', { status: 404 });
		}
		if (isDeveloperPortal && path === '/') redirect(303, '/utvikler');
	}

	// Platform administration is reached only on the platform's own hostname,
	// and the organisation's pages are not reachable from there.
	if (config.tenant.platformHostname) {
		if (path.startsWith('/systemadmin') && !isPlatform) {
			return new Response('Plattformadministrasjon nås på et eget vertsnavn.', { status: 404 });
		}
		if (isPlatform && !path.startsWith('/systemadmin') && !path.startsWith('/logg-inn') && !path.startsWith('/logg-ut') && path !== '/') {
			return new Response('Denne adressen er forbeholdt plattformadministrasjon.', { status: 404 });
		}
	}

	// Rate limiting. The authentication endpoints are stricter than the rest.
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

	/**
	 * Same-origin check for form submissions to the record's own pages.
	 *
	 * This is the protection SvelteKit does by default, kept but narrowed. A
	 * form posted from another site with the user's cookies riding along is what
	 * it stops, and that only applies where cookies are used - the record's own
	 * pages. The OAuth and FHIR endpoints authenticate by token and never read a
	 * cookie, and a public SMART app has to post to the token endpoint from its
	 * own origin, which the framework's version refused.
	 */
	const skjemaposting =
		['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.request.method) &&
		['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].some((t) =>
			(event.request.headers.get('content-type') ?? '').startsWith(t)
		);
	const apiSti = path.startsWith('/fhir') || path.startsWith('/api') || path.startsWith('/oauth') || isCds;
	if (skjemaposting && !apiSti) {
		const origin = event.request.headers.get('origin');
		if (origin !== event.url.origin) {
			return new Response('Kryssopphavs-postering avvist.', { status: 403 });
		}
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
	// Details are logged on the server; the client gets only a correlation id, so
	// that internal error messages do not leak information about the system.
	console.error(`[feil] ${requestId} ${event.url.pathname}`, error);
	return {
		message: 'Det oppsto en uventet feil. Kontakt systemansvarlig og oppgi referansen.',
		code: 'intern_feil',
		requestId
	};
};
