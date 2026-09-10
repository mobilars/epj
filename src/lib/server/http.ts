import type { RequestEvent } from '@sveltejs/kit';
import { one, exec } from './db';
import { config } from './config';
import { currentTenant } from './tenant/context';

/** Derives the client IP from trusted proxy headers. */
export function clientIp(event: RequestEvent): string {
	const hops = config.security.trustedProxyHops;
	const forwarded = event.request.headers.get('x-forwarded-for');
	if (forwarded && hops > 0) {
		const chain = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
		// Take the address `hops` from the end - anything further left may have
		// been set by the client itself.
		//
		// If the chain is shorter than the number of trusted hops, it has not been
		// through the proxies we believe. The whole header is then the client's own
		// work and we do not use it: otherwise anyone could pick their own address,
		// and both per-IP rate limiting and source IP in the audit log would be worthless.
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
 * Simple counter-based rate limiting in the database.
 * Shared between instances, and survives the app being scaled horizontally.
 */
export async function rateLimit(
	bucket: string,
	max: number,
	windowSekunder: number
): Promise<{ allowed: boolean; remaining: number; nullstillesAbout: number }> {
	// The organisation is part of the key, so one organisation's traffic cannot
	// shut out another's.
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

/** Maintenance. Deliberately across organisations: deletes only old counters. */
export async function purgeRateLimit(): Promise<number> {
	return exec('DELETE FROM rate_limit WHERE window_start < $1', [Math.floor(Date.now() / 1000) - 86400]);
}

/**
 * Security headers.
 *
 * The content security policy for HTML pages is set by SvelteKit itself
 * (`kit.csp` in svelte.config.js), so the framework's own inline scripts get
 * the right nonce. The remaining headers are set here, plus a minimal policy
 * for API responses, which are never rendered as HTML.
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
		// API responses are not rendered as HTML; a minimal policy is enough.
		return { ...shared, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' };
	}
	return { ...shared, 'cache-control': 'no-store, no-cache, must-revalidate' };
}

/** CORS for the FHIR endpoint. SMART apps run in the browser from their own origins. */
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
