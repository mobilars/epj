import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP etter RFC 6238 med SHA-1, 6 siffer og 30 sekunders vindu (Google Authenticator-kompatibelt). */

const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function nyTotpHemmelighet(bytes = 20): string {
	return base32Enkod(randomBytes(bytes));
}

export function base32Enkod(buf: Buffer): string {
	let bits = 0;
	let verdi = 0;
	let ut = '';
	for (const b of buf) {
		verdi = (verdi << 8) | b;
		bits += 8;
		while (bits >= 5) {
			ut += ALFABET[(verdi >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) ut += ALFABET[(verdi << (5 - bits)) & 31];
	return ut;
}

export function base32Dekod(s: string): Buffer {
	const rens = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
	let bits = 0;
	let verdi = 0;
	const ut: number[] = [];
	for (const tegn of rens) {
		const idx = ALFABET.indexOf(tegn);
		if (idx === -1) throw new Error('Ugyldig base32-tegn');
		verdi = (verdi << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			ut.push((verdi >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(ut);
}

export function totpKode(hemmelighet: string, tidssteg = Math.floor(Date.now() / 30000)): string {
	const nokkel = base32Dekod(hemmelighet);
	const teller = Buffer.alloc(8);
	teller.writeBigUInt64BE(BigInt(tidssteg));
	const hmac = createHmac('sha1', nokkel).update(teller).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const binær = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
	return String(binær % 1_000_000).padStart(6, '0');
}

/** Godtar koder inntil `vindu` tidssteg bakover og framover (klokkeavvik). */
export function verifiserTotp(hemmelighet: string, kode: string, vindu = 1): boolean {
	const rens = kode.replace(/\s/g, '');
	if (!/^\d{6}$/.test(rens)) return false;
	const nå = Math.floor(Date.now() / 30000);
	for (let d = -vindu; d <= vindu; d++) {
		const forventet = totpKode(hemmelighet, nå + d);
		if (timingSafeEqual(Buffer.from(forventet), Buffer.from(rens))) return true;
	}
	return false;
}

export function otpauthUrl(hemmelighet: string, bruker: string, utsteder: string): string {
	const label = encodeURIComponent(`${utsteder}:${bruker}`);
	const params = new URLSearchParams({ secret: hemmelighet, issuer: utsteder, algorithm: 'SHA1', digits: '6', period: '30' });
	return `otpauth://totp/${label}?${params}`;
}
