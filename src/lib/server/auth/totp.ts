import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP etter RFC 6238 med SHA-1, 6 siffer og 30 sekunders vindu (Google Authenticator-kompatibelt). */

const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(bytes = 20): string {
	return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of buf) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += ALFABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALFABET[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Buffer {
	const sanitise = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const tegn of sanitise) {
		const idx = ALFABET.indexOf(tegn);
		if (idx === -1) throw new Error('Ugyldig base32-tegn');
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export function totpCode(secret: string, tidssteg = Math.floor(Date.now() / 30000)): string {
	const key = base32Decode(secret);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(tidssteg));
	const hmac = createHmac('sha1', key).update(counter).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
	return String(binary % 1_000_000).padStart(6, '0');
}

/** Godtar koder inntil `vindu` tidssteg bakover og framover (klokkeavvik). */
export function verifyTotp(secret: string, code: string, window = 1): boolean {
	const sanitise = code.replace(/\s/g, '');
	if (!/^\d{6}$/.test(sanitise)) return false;
	const now = Math.floor(Date.now() / 30000);
	for (let d = -window; d <= window; d++) {
		const expected = totpCode(secret, now + d);
		if (timingSafeEqual(Buffer.from(expected), Buffer.from(sanitise))) return true;
	}
	return false;
}

export function otpauthUrl(secret: string, user: string, issuer: string): string {
	const label = encodeURIComponent(`${issuer}:${user}`);
	const params = new URLSearchParams({ secret: secret, issuer: issuer, algorithm: 'SHA1', digits: '6', period: '30' });
	return `otpauth://totp/${label}?${params}`;
}
