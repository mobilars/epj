import type { RequestEvent } from '@sveltejs/kit';
import { en, exec } from './db';
import { config } from './config';

/** Utleder klient-IP fra betrodde proxy-headere. */
export function klientIp(event: RequestEvent): string {
	const hops = config.security.trustedProxyHops;
	const forwarded = event.request.headers.get('x-forwarded-for');
	if (forwarded && hops > 0) {
		const kjede = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
		// Ta adressen som ligger `hops` fra slutten - alt lenger til venstre kan
		// klienten selv ha satt.
		const idx = Math.max(0, kjede.length - hops);
		if (kjede[idx]) return kjede[idx];
	}
	try {
		return event.getClientAddress();
	} catch {
		return 'ukjent';
	}
}

/**
 * Enkel tellerbasert ratebegrensning i databasen.
 * Deles mellom instanser, og tåler at appen skaleres horisontalt.
 */
export async function rateLimit(
	bucket: string,
	maks: number,
	vinduSekunder: number
): Promise<{ tillatt: boolean; gjenstaende: number; nullstillesOm: number }> {
	const nå = Math.floor(Date.now() / 1000);
	const vinduStart = nå - (nå % vinduSekunder);
	const rad = await en<{ teller: number }>(
		`INSERT INTO rate_limit (bucket, teller, vindu_start) VALUES ($1, 1, $2)
		 ON CONFLICT (bucket) DO UPDATE SET
		   teller = CASE WHEN rate_limit.vindu_start = $2 THEN rate_limit.teller + 1 ELSE 1 END,
		   vindu_start = $2
		 RETURNING teller`,
		[bucket, vinduStart]
	);
	const teller = rad?.teller ?? 1;
	return {
		tillatt: teller <= maks,
		gjenstaende: Math.max(0, maks - teller),
		nullstillesOm: vinduStart + vinduSekunder - nå
	};
}

export async function ryddRateLimit(): Promise<number> {
	return exec('DELETE FROM rate_limit WHERE vindu_start < $1', [Math.floor(Date.now() / 1000) - 86400]);
}

/**
 * Sikkerhetsheadere.
 *
 * Innholdssikkerhetspolicyen for HTML-sider settes av SvelteKit selv
 * (`kit.csp` i svelte.config.js), slik at rammeverkets egne innebygde skript
 * får riktig nonce. Her settes de øvrige headerne, pluss en minimal policy for
 * API-svar, som aldri rendres som HTML.
 */
export function sikkerhetsheadere(erFhirApi: boolean): Record<string, string> {
	const felles: Record<string, string> = {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'cross-origin-opener-policy': 'same-origin',
		'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
		'x-frame-options': 'DENY'
	};
	if (config.security.httpsOnly) {
		felles['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
	}
	if (erFhirApi) {
		// API-svar rendres ikke som HTML; en minimal policy holder.
		return { ...felles, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' };
	}
	return { ...felles, 'cache-control': 'no-store, no-cache, must-revalidate' };
}

/** CORS for FHIR-endepunktet. SMART-apper kjører i nettleseren fra egne opphav. */
export function corsHeadere(origin: string | null, tillatteOpphav: string[]): Record<string, string> {
	if (!origin) return {};
	const tillatt = tillatteOpphav.includes(origin) || tillatteOpphav.includes('*');
	if (!tillatt) return {};
	return {
		'access-control-allow-origin': origin,
		'access-control-allow-credentials': 'false',
		'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
		'access-control-allow-headers': 'authorization, content-type, if-match, if-none-exist, prefer, x-request-id',
		'access-control-expose-headers': 'etag, location, last-modified, content-location',
		'access-control-max-age': '600',
		vary: 'Origin'
	};
}
