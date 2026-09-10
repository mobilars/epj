import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Kontroll av utgående HTTP-kall som styres av data, ikke av konfigurasjon.
 *
 * Adressene til HelseID, SFM, NHN og Helfo settes av den som drifter systemet
 * og er derfor til å stole på. `jwks_uri` på en registrert app er noe annet:
 * den kommer fra et skjemafelt, og lagres i databasen. Uten kontroll blir
 * journalen en maskin som henter vilkårlige adresser på vegne av den som fylte
 * ut skjemaet - inkludert adresser bare journalen selv kan nå:
 * metadatatjenesten til skyleverandøren, Kubernetes-API-et, HAPI FHIR, eller
 * databasen. Det er SSRF (OWASP A10).
 *
 * Kontrollen er derfor:
 *
 *   1. bare https
 *   2. ingen omdirigeringer - ellers kan et lovlig navn sende oss videre til et
 *      ulovlig et
 *   3. navnet slås opp, og adressen må være offentlig; det stenger både
 *      `http://127.0.0.1` og et navn som med vilje peker på 169.254.169.254
 *   4. kort tidsavbrudd og tak på svarstørrelsen
 */

/** Adresseområder som aldri skal nås fra et datastyrt kall. */
function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 6) {
		const v = ip.toLowerCase();
		if (v === '::1' || v === '::') return true;
		if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
		// IPv4-mappet IPv6. `new URL()` normaliserer `::ffff:127.0.0.1` til
		// `::ffff:7f00:1`, så begge skrivemåtene må gjenkjennes.
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
			// Ukjent form på en mappet adresse: vi vet ikke hvor den peker.
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

/** Kontrollerer at adressen er lovlig som mål for et datastyrt kall. */
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
	// Alle adressene må være offentlige. Peker én av dem innover, avvises navnet:
	// vi kan ikke styre hvilken av dem tilkoblingen ender på.
	for (const a of addresses) {
		if (isPrivateAddress(a.address)) throw new OutboundError('Navnet peker inn i et internt nett');
	}
	return url;
}

/**
 * Henter JSON fra en datastyrt adresse. Følger ikke omdirigeringer, og leser
 * aldri mer enn `maksBytes`.
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
