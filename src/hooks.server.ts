import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { config } from '$srv/config';
import { klientIp, rateLimit, sikkerhetsheadere } from '$srv/http';
import { hentSesjon } from '$srv/auth/session';
import { hentBruker, rollerFor } from '$srv/auth/brukere';
import { validerAccessToken } from '$srv/auth/tokens';
import { parseScopes } from '$srv/authz/scopes';
import { rettigheterForRoller, scopesForRoller } from '$srv/authz/roles';
import type { AuthContext } from '$srv/authz/context';
import { migrer } from '$srv/db/migrate';
import { logg } from '$srv/audit';
import { medTenant, PLATTFORM_TENANT, type Tenant } from '$srv/tenant/kontekst';
import { hentTenant, hentTenantPaVertsnavn, sikreStandardvirksomhet } from '$srv/tenant/tenant';

let migrertOk: Promise<unknown> | null = null;

/** Kjører migrasjoner én gang ved oppstart. */
function sikreSkjema(): Promise<unknown> {
	if (!migrertOk) {
		migrertOk = migrer()
			.then(() => sikreStandardvirksomhet())
			.catch((err) => {
				console.error('[oppstart] migrering feilet', err);
				migrertOk = null;
				throw err;
			});
	}
	return migrertOk;
}

/** Bygger tilgangskontekst for en innlogget sesjon i journalens eget grensesnitt. */
async function kontekstFraSesjon(event: Parameters<Handle>[0]['event'], requestId: string): Promise<AuthContext | null> {
	const sesjon = await hentSesjon(event.cookies);
	if (!sesjon) return null;
	const bruker = await hentBruker(sesjon.user_id);
	if (!bruker || bruker.status !== 'aktiv') return null;
	const roller = await rollerFor(bruker.id);
	return {
		mate: 'session',
		userId: bruker.id,
		actorRef: bruker.practitioner_id ? `Practitioner/${bruker.practitioner_id}` : `Person/${bruker.id}`,
		navn: bruker.navn,
		roller,
		rettigheter: rettigheterForRoller(roller),
		// Journalens eget grensesnitt får alle scopes rollen tillater.
		scopes: parseScopes([...scopesForRoller(roller)].join(' ')),
		clientId: null,
		clientNavn: 'EPJ',
		launch: {},
		sessionId: sesjon.id,
		tokenId: null,
		amr: sesjon.amr ?? 'pwd',
		elevertTil: sesjon.elevert_til,
		ip: klientIp(event),
		requestId
	};
}

async function kontekstFraBearer(authorization: string, event: Parameters<Handle>[0]['event'], requestId: string): Promise<AuthContext | null> {
	const token = authorization.slice(7).trim();
	const resultat = await validerAccessToken(token);
	if (!resultat.gyldig || !resultat.ctx) return null;
	return { ...resultat.ctx, ip: klientIp(event), requestId };
}

/**
 * Finner hvilken virksomhet forespørselen gjelder.
 *
 * Utledes av vertsnavnet, aldri av noe klienten kan velge. Ukjent vertsnavn
 * avvises i produksjon; i utvikling faller vi tilbake på standardvirksomheten,
 * slik at localhost virker uten oppsett.
 */
async function losTenant(vertsnavn: string): Promise<{ tenant: Tenant; erPlattform: boolean } | { feil: string; status: number }> {
	if (config.tenant.plattformVertsnavn && vertsnavn === config.tenant.plattformVertsnavn) {
		const plattform = await hentTenant(PLATTFORM_TENANT);
		if (!plattform) return { feil: 'Plattformvirksomheten mangler', status: 500 };
		return { tenant: plattform, erPlattform: true };
	}

	const funnet = await hentTenantPaVertsnavn(vertsnavn);
	if (funnet) {
		if (funnet.status !== 'aktiv') {
			return { feil: `Virksomheten er ${funnet.status}. Kontakt leverandøren.`, status: 503 };
		}
		return { tenant: funnet, erPlattform: false };
	}

	if (!config.tenant.tillatUkjentVertsnavn) {
		return { feil: `Ukjent vertsnavn: ${vertsnavn}`, status: 404 };
	}
	const standard = await hentTenant(config.tenant.standard);
	if (!standard) return { feil: 'Standardvirksomheten mangler. Kjør migrasjonene.', status: 500 };
	return { tenant: standard, erPlattform: false };
}

export const handle: Handle = async ({ event, resolve }) => {
	await sikreSkjema();

	const losning = await losTenant(event.url.hostname);
	if ('feil' in losning) {
		return new Response(losning.feil, { status: losning.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	event.locals.tenant = losning.tenant;
	event.locals.erPlattform = losning.erPlattform;

	// Resten av forespørselen kjører i virksomhetens kontekst. Spørringer som
	// glemmer avgrensningen feiler dermed høylytt i stedet for å hente andres data.
	return medTenant(losning.tenant, () => handterIKontekst(event, resolve, losning.erPlattform));
};

async function handterIKontekst(
	event: Parameters<Handle>[0]['event'],
	resolve: Parameters<Handle>[0]['resolve'],
	erPlattform: boolean
): Promise<Response> {
	const requestId = event.request.headers.get('x-request-id') ?? randomUUID();
	event.locals.requestId = requestId;
	event.locals.clientIp = klientIp(event);
	event.locals.auth = null;

	const sti = event.url.pathname;
	const erFhirApi = sti.startsWith('/fhir') || sti.startsWith('/api') || sti.startsWith('/oauth');

	// Plattformadministrasjonen nås bare på plattformens eget vertsnavn, og
	// virksomhetens sider nås ikke derfra.
	if (config.tenant.plattformVertsnavn) {
		if (sti.startsWith('/systemadmin') && !erPlattform) {
			return new Response('Plattformadministrasjon nås på et eget vertsnavn.', { status: 404 });
		}
		if (erPlattform && !sti.startsWith('/systemadmin') && !sti.startsWith('/logg-inn') && !sti.startsWith('/logg-ut') && sti !== '/') {
			return new Response('Denne adressen er forbeholdt plattformadministrasjon.', { status: 404 });
		}
	}

	// Ratebegrensning. Autentiseringsendepunktene er strengere enn resten.
	const strengt = sti.startsWith('/oauth/token') || sti === '/logg-inn';
	const grense = await rateLimit(
		`${strengt ? 'auth' : 'alm'}:${event.locals.clientIp}`,
		strengt ? config.security.rateLimit.autentiseringPerMinutt : config.security.rateLimit.generellPerMinutt,
		60
	);
	if (!grense.tillatt) {
		return new Response(
			JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'throttled', diagnostics: 'For mange forespørsler' }] }),
			{ status: 429, headers: { 'content-type': 'application/fhir+json', 'retry-after': String(grense.nullstillesOm) } }
		);
	}

	const authorization = event.request.headers.get('authorization');
	if (authorization?.toLowerCase().startsWith('bearer ')) {
		event.locals.auth = await kontekstFraBearer(authorization, event, requestId);
		if (!event.locals.auth && sti.startsWith('/fhir')) {
			await logg(
				{ type: 'security-alert', subtype: 'token-avvist', handling: 'E', utfall: '4', utfallBeskrivelse: 'Ugyldig eller utløpt access token', entityRef: sti },
				{ userId: null, actorRef: 'Device/ukjent', navn: 'ukjent', rolle: null, clientId: null, ip: event.locals.clientIp, requestId }
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
		event.locals.auth = await kontekstFraSesjon(event, requestId);
	}

	const svar = await resolve(event);

	for (const [k, v] of Object.entries(sikkerhetsheadere(erFhirApi))) {
		svar.headers.set(k, v);
	}
	svar.headers.set('x-request-id', requestId);
	return svar;
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
