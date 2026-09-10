import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Control of outbound HTTP calls that are driven by data, not configuration.
 *
 * The addresses of HelseID, SFM, NHN and Helfo are set by whoever operates the
 * system and are therefore trustworthy. `jwks_uri` on a registered app is
 * another matter: it comes from a form field and is stored in the database.
 * Unchecked, the record becomes a machine that fetches arbitrary addresses on
 * behalf of whoever filled in the form - including addresses only the record
 * itself can reach: the cloud provider's metadata service, the Kubernetes API,
 * HAPI FHIR, or the database. That is SSRF (OWASP A10).
 *
 * So the check is:
 *
 *   1. https only
 *   2. no redirects - otherwise a permitted name can send us on to a forbidden one
 *   3. the name is resolved, and the address must be public; that closes both
 *      `http://127.0.0.1` and a name deliberately pointing at 169.254.169.254
 *   4. a short timeout and a cap on the response size
 */

/** Address ranges that must never be reached from a data-driven call. */
function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 6) {
		const v = ip.toLowerCase();
		if (v === '::1' || v === '::') return true;
		if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
		// IPv4-mapped IPv6. `new URL()` normalises `::ffff:127.0.0.1` to
		// `::ffff:7f00:1`, so both spellings must be recognised.
		const mappet = /^::ffff:(.+)$/.exec(v);
		if (mappet) {
			const rest = mappet[1];
			if (isIP(rest) === 4) return isPrivateAddress(rest);
			const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
			if (hex) {
				const hoy = Number.parseInt(hex[1], 16);
				const lav = Number.parseInt(hex[2], 16);
				return isPrivateAddress(`${hoy >> 8}.${hoy & 255}.${lav >> 8}.${lav & 255}`);
			}
			// Unknown form of a mapped address: we do not know where it points.
			return true;
		}
		return false;
	}
	const d = ip.split('.').map(Number);
	if (d.length !== 4 || d.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = d;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // lenkelokal, inkl. skymetadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a >= 224) return true; // multicast og reservert
	return false;
}

export class OutboundError extends Error {}

/** Checks that the address is a legal target for a data-driven call. */
export async function checkOutboundUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OutboundError('Adressen er ikke en gyldig URL');
	}
	if (url.protocol !== 'https:') throw new OutboundError('Adressen må bruke https');
	if (url.username || url.password) throw new OutboundError('Adressen kan ikke inneholde legitimasjon');

	const vert = url.hostname.replace(/^\[|\]$/g, '');
	if (isIP(vert)) {
		if (isPrivateAddress(vert)) throw new OutboundError('Adressen peker inn i et internt nett');
		return url;
	}
	let addresses: { address: string }[];
	try {
		addresses = await lookup(vert, { all: true });
	} catch {
		throw new OutboundError('Navnet kunne ikke slås opp');
	}
	if (addresses.length === 0) throw new OutboundError('Navnet kunne ikke slås opp');
	// Every address must be public. If one points inward the name is refused:
	// we cannot control which of them the connection ends up on.
	for (const a of addresses) {
		if (isPrivateAddress(a.address)) throw new OutboundError('Navnet peker inn i et internt nett');
	}
	return url;
}

/**
 * Fetches JSON from a data-driven address. Does not follow redirects, and never
 * reads more than `maxBytes`.
 */
export async function getJsonUtenfra(
	raw: string,
	{ timeoutMs = 5000, maxBytes = 512 * 1024 } = {}
): Promise<unknown> {
	const url = await checkOutboundUrl(raw);
	const response = await fetch(url, {
		redirect: 'manual',
		signal: AbortSignal.timeout(timeoutMs),
		headers: { accept: 'application/json' }
	});
	if (response.status >= 300 && response.status < 400) {
		throw new OutboundError('Adressen svarte med en omdirigering, som ikke følges');
	}
	if (!response.ok) throw new OutboundError(`Adressen svarte ${response.status}`);
	const text = (await response.text()).slice(0, maxBytes);
	try {
		return JSON.parse(text);
	} catch {
		throw new OutboundError('Svaret var ikke gyldig JSON');
	}
}

/**
 * Posts to a data-driven address and returns the body as text.
 *
 * The same guard as `getJsonUtenfra`: the address is resolved and checked
 * before anything is sent, redirects are not followed, and the response is
 * capped. Used for CDS Hooks, where the address comes from what a practice
 * registered rather than from us.
 */
export async function fetchOutbound(
	raw: string,
	{
		method = 'GET',
		body,
		headers = {},
		timeoutMs = 5000,
		maxBytes = 512 * 1024
	}: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {}
): Promise<string> {
	const url = await checkOutboundUrl(raw);
	const response = await fetch(url, {
		method,
		body,
		redirect: 'manual',
		signal: AbortSignal.timeout(timeoutMs),
		headers: { accept: 'application/json', ...headers }
	});
	if (response.status >= 300 && response.status < 400) {
		throw new OutboundError('Adressen svarte med en omdirigering, som ikke følges');
	}
	if (!response.ok) throw new OutboundError(`Adressen svarte ${response.status}`);
	return (await response.text()).slice(0, maxBytes);
}
