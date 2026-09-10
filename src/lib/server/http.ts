import type { RequestEvent } from '@sveltejs/kit';
import { one, exec } from './db';
import { config } from './config';
import { currentTenant } from './tenant/context';

/** Utleder klient-IP fra betrodde proxy-headere. */
export function clientIp(event: RequestEvent): string {
	const hops = config.security.trustedProxyHops;
	const forwarded = event.request.headers.get('x-forwarded-for');
	if (forwarded && hops > 0) {
		const chain = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
		// Ta adressen som ligger `hops` fra slutten - alt lenger til venstre kan
		// klienten selv ha satt.
		//
		// Er kjeden kortere enn antall betrodde hopp, har den ikke vært gjennom de
		// proxyene vi tror. Da er hele headeren klientens eget verk, og vi bruker
		// den ikke: ellers kunne hvem som helst velge sin egen adresse, og både
		// ratebegrensningen per IP og kilde-IP i sikkerhetsloggen ville vært verdiløs.
		if (chain.length >= hops) {
			const candidate = chain[chain.length - hops];
			if (candidate) return candidate;
		}
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
	max: number,
	windowSekunder: number
): Promise<{ allowed: boolean; remaining: number; nullstillesAbout: number }> {
	// Virksomheten inngår i nøkkelen, slik at én virksomhets trafikk ikke kan
	// stenge ute en annen.
	const key = `${currentTenant()?.id ?? 'ukjent'}:${bucket}`;
	const now = Math.floor(Date.now() / 1000);
	const windowStart = now - (now % windowSekunder);
	const row = await one<{ counter: number }>(
		`INSERT INTO rate_limit (bucket, counter, window_start) VALUES ($1, 1, $2)
		 ON CONFLICT (bucket) DO UPDATE SET
		   counter = CASE WHEN rate_limit.window_start = $2 THEN rate_limit.counter + 1 ELSE 1 END,
		   window_start = $2
		 RETURNING counter`,
		[key, windowStart]
	);
	const counter = row?.counter ?? 1;
	return {
		allowed: counter <= max,
		remaining: Math.max(0, max - counter),
		nullstillesAbout: windowStart + windowSekunder - now
	};
}

/** Vedlikehold. Går bevisst på tvers av virksomheter: sletter bare gamle tellere. */
export async function purgeRateLimit(): Promise<number> {
	return exec('DELETE FROM rate_limit WHERE window_start < $1', [Math.floor(Date.now() / 1000) - 86400]);
}

/**
 * Sikkerhetsheadere.
 *
 * Innholdssikkerhetspolicyen for HTML-sider settes av SvelteKit selv
 * (`kit.csp` i svelte.config.js), slik at rammeverkets egne innebygde skript
 * får riktig nonce. Her settes de øvrige headerne, pluss en minimal policy for
 * API-svar, som aldri rendres som HTML.
 */
export function securityHeaders(isFhirApi: boolean): Record<string, string> {
	const shared: Record<string, string> = {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'cross-origin-opener-policy': 'same-origin',
		'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
		'x-frame-options': 'DENY'
	};
	if (config.security.httpsOnly) {
		shared['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
	}
	if (isFhirApi) {
		// API-svar rendres ikke som HTML; en minimal policy holder.
		return { ...shared, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' };
	}
	return { ...shared, 'cache-control': 'no-store, no-cache, must-revalidate' };
}

/** CORS for FHIR-endepunktet. SMART-apper kjører i nettleseren fra egne opphav. */
export function corsHeadere(origin: string | null, allowedOpphav: string[]): Record<string, string> {
	if (!origin) return {};
	const allowed = allowedOpphav.includes(origin) || allowedOpphav.includes('*');
	if (!allowed) return {};
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
