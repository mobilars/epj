import { config } from '../config';
import { FhirError, issue } from './outcome';
import type { Bundle, FhirResource } from './types';

/**
 * Klient mot HAPI FHIR JPA-serveren.
 *
 * HAPI eier de kliniske dataene: lagring, versjonshistorikk, søkeindeksering,
 * `$everything`, `$validate` og profilvalidering mot de norske basisprofilene.
 * Denne klienten er bevisst tynn - all forretningslogikk og tilgangskontroll
 * ligger i `gateway.ts`, som er det eneste som skal kalle hit.
 */

export interface FhirRespons<T = FhirResource> {
	status: number;
	ressurs: T;
	etag?: string;
	location?: string;
	lastModified?: string;
}

export interface KallOpsjoner {
	/** Videreføres som `X-Request-Id` for korrelering mellom EPJ-logg og HAPI-logg. */
	requestId?: string;
	ifMatch?: string;
	ifNoneExist?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

function autorisasjonsHeader(): Record<string, string> {
	const { brukernavn, passord } = config.fhirServer;
	if (!brukernavn) return {};
	return { authorization: `Basic ${Buffer.from(`${brukernavn}:${passord}`).toString('base64')}` };
}

async function kall(
	metode: string,
	sti: string,
	kropp?: unknown,
	opsjoner: KallOpsjoner = {}
): Promise<FhirRespons> {
	const url = sti.startsWith('http') ? sti : `${config.fhirServer.baseUrl}/${sti.replace(/^\//, '')}`;
	const kontroller = new AbortController();
	const timeout = setTimeout(() => kontroller.abort(), config.fhirServer.timeoutMs);
	opsjoner.signal?.addEventListener('abort', () => kontroller.abort());

	let svar: Response;
	try {
		svar = await fetch(url, {
			method: metode,
			headers: {
				accept: 'application/fhir+json',
				...(kropp !== undefined ? { 'content-type': 'application/fhir+json' } : {}),
				...(opsjoner.ifMatch ? { 'if-match': opsjoner.ifMatch } : {}),
				...(opsjoner.ifNoneExist ? { 'if-none-exist': opsjoner.ifNoneExist } : {}),
				...(opsjoner.requestId ? { 'x-request-id': opsjoner.requestId } : {}),
				...autorisasjonsHeader(),
				...opsjoner.headers
			},
			body: kropp === undefined ? undefined : JSON.stringify(kropp),
			signal: kontroller.signal
		});
	} catch (err) {
		throw new FhirError(503, [
			issue('fatal', 'transient', `Får ikke kontakt med FHIR-serveren: ${(err as Error).message}`)
		]);
	} finally {
		clearTimeout(timeout);
	}

	const tekst = await svar.text();
	let kropp2: unknown = undefined;
	if (tekst.length > 0) {
		try {
			kropp2 = JSON.parse(tekst);
		} catch {
			kropp2 = { resourceType: 'OperationOutcome', issue: [issue('fatal', 'exception', tekst.slice(0, 500))] };
		}
	}

	if (!svar.ok) {
		const outcome = kropp2 as { resourceType?: string; issue?: unknown[] } | undefined;
		const issues = outcome?.resourceType === 'OperationOutcome' && Array.isArray(outcome.issue)
			? (outcome.issue as never[])
			: [issue('error', 'processing', `FHIR-serveren svarte ${svar.status}`)];
		throw new FhirError(svar.status, issues);
	}

	return {
		status: svar.status,
		ressurs: (kropp2 ?? {}) as FhirResource,
		etag: svar.headers.get('etag') ?? undefined,
		location: svar.headers.get('location') ?? undefined,
		lastModified: svar.headers.get('last-modified') ?? undefined
	};
}

export const fhirKlient = {
	async les(resourceType: string, id: string, o?: KallOpsjoner): Promise<FhirResource> {
		return (await kall('GET', `${resourceType}/${encodeURIComponent(id)}`, undefined, o)).ressurs;
	},

	async lesVersjon(resourceType: string, id: string, versionId: string, o?: KallOpsjoner): Promise<FhirResource> {
		return (await kall('GET', `${resourceType}/${encodeURIComponent(id)}/_history/${encodeURIComponent(versionId)}`, undefined, o)).ressurs;
	},

	async historikk(resourceType: string, id: string, query = new URLSearchParams(), o?: KallOpsjoner): Promise<Bundle> {
		const qs = query.toString();
		return (await kall('GET', `${resourceType}/${encodeURIComponent(id)}/_history${qs ? `?${qs}` : ''}`, undefined, o)).ressurs as Bundle;
	},

	async sok(resourceType: string, query: URLSearchParams, o?: KallOpsjoner): Promise<Bundle> {
		// POST mot /_search brukes framfor GET, slik at pasientidentifikatorer ikke
		// havner i URL-er og dermed i mellomliggende tilgangslogger.
		return this.sokPost(resourceType, query, o);
	},

	/** Søk med POST og skjemakodet kropp (foretrukket for pasientnære søk). */
	async sokPost(resourceType: string, query: URLSearchParams, o?: KallOpsjoner): Promise<Bundle> {
		const url = `${config.fhirServer.baseUrl}/${resourceType}/_search`;
		const svar = await fetch(url, {
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
		const tekst = await svar.text();
		const kropp = tekst ? JSON.parse(tekst) : {};
		if (!svar.ok) {
			throw new FhirError(svar.status, (kropp as { issue?: never[] }).issue ?? [issue('error', 'processing', `FHIR-serveren svarte ${svar.status}`)]);
		}
		return kropp as Bundle;
	},

	async opprett(ressurs: FhirResource, o?: KallOpsjoner): Promise<FhirRespons> {
		return kall('POST', ressurs.resourceType, ressurs, o);
	},

	async oppdater(resourceType: string, id: string, ressurs: FhirResource, o?: KallOpsjoner): Promise<FhirRespons> {
		return kall('PUT', `${resourceType}/${encodeURIComponent(id)}`, { ...ressurs, resourceType, id }, o);
	},

	async patch(resourceType: string, id: string, patch: unknown[], o?: KallOpsjoner): Promise<FhirRespons> {
		return kall('PATCH', `${resourceType}/${encodeURIComponent(id)}`, patch, {
			...o,
			headers: { ...o?.headers, 'content-type': 'application/json-patch+json' }
		});
	},

	async slett(resourceType: string, id: string, o?: KallOpsjoner): Promise<FhirRespons> {
		return kall('DELETE', `${resourceType}/${encodeURIComponent(id)}`, undefined, o);
	},

	async transaksjon(bundle: Bundle, o?: KallOpsjoner): Promise<Bundle> {
		return (await kall('POST', '', bundle, o)).ressurs as Bundle;
	},

	async operasjon(sti: string, parametre?: FhirResource, o?: KallOpsjoner): Promise<FhirResource> {
		return (await kall(parametre ? 'POST' : 'GET', sti, parametre, o)).ressurs;
	},

	/** Pasientens samlede journal. HAPI implementerer $everything med paginering. */
	async everything(patientId: string, query = new URLSearchParams(), o?: KallOpsjoner): Promise<Bundle> {
		const qs = query.toString();
		return (await kall('GET', `Patient/${encodeURIComponent(patientId)}/$everything${qs ? `?${qs}` : ''}`, undefined, o)).ressurs as Bundle;
	},

	async valider(ressurs: FhirResource, profil?: string, o?: KallOpsjoner): Promise<FhirResource> {
		const sti = `${ressurs.resourceType}/$validate${profil ? `?profile=${encodeURIComponent(profil)}` : ''}`;
		try {
			return (await kall('POST', sti, ressurs, o)).ressurs;
		} catch (err) {
			if (err instanceof FhirError) return err.toOutcome();
			throw err;
		}
	},

	async capabilityStatement(o?: KallOpsjoner): Promise<FhirResource> {
		return (await kall('GET', 'metadata', undefined, o)).ressurs;
	},

	/** Enkel helsesjekk brukt av /api/helse og oppstartssekvensen. */
	async erTilgjengelig(): Promise<boolean> {
		try {
			await kall('GET', 'metadata?_summary=true');
			return true;
		} catch {
			return false;
		}
	}
};
