import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	scryptSync,
	timingSafeEqual
} from 'node:crypto';
import { config } from '../config';

const KEY_LEN = 32;

/**
 * Derived key, cached per EPJ_DATA_KEY.
 *
 * scrypt is deliberately expensive - that is the point of it for passwords. But
 * this key is derived from a configuration value, not from something an
 * attacker guesses, and `tokenHash()` uses it on *every* session lookup, which
 * means on every single request. Without caching the server pays a full scrypt
 * round per call, and the rate limit of 600 requests a minute becomes a recipe
 * for burning the CPU.
 *
 * The key is cached against the value it was derived from, so rotating the key
 * within the same process produces a fresh derivation.
 */
let bufretKey: { from: string; key: Buffer } | null = null;

function masterKey(): Buffer {
	const from = config.dataEncryptionKey;
	if (bufretKey?.from === from) return bufretKey.key;
	// EPJ_DATA_KEY is stretched to 32 bytes with a fixed, application-specific salt.
	const key = scryptSync(from, 'epj-data-key-v1', KEY_LEN);
	bufretKey = { from, key };
	return key;
}

/** AES-256-GCM. Format: v1.<iv>.<tag>.<ciphertext>, every part base64url. */
export function encrypt(klartekst: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([cipher.update(klartekst, 'utf8'), cipher.final()]);
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(chiffertekst: string): string {
	const [version, ivB64, tagB64, ctB64] = chiffertekst.split('.');
	if (version !== 'v1') throw new Error('Ukjent krypteringsformat');
	const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64url'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Password hashing with scrypt. Format: scrypt$N$r$p$salt$hash */
export function hashPassword(password: string): string {
	const N = 16384, r = 8, p = 1;
	const salt = randomBytes(16);
	const hash = scryptSync(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
	return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
	try {
		const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
		if (alg !== 'scrypt') return false;
		const salt = Buffer.from(saltB64, 'base64url');
		const expected = Buffer.from(hashB64, 'base64url');
		const faktisk = scryptSync(password.normalize('NFKC'), salt, expected.length, {
			N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
		});
		return timingSafeEqual(expected, faktisk);
	} catch {
		return false;
	}
}

/** Hash used to look tokens up. Tokens are never stored in the clear. */
export function tokenHash(token: string): string {
	return createHmac('sha256', masterKey()).update(token).digest('base64url');
}

export function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('base64url');
}

export function likeStrenger(a: string, b: string): boolean {
	const ab = Buffer.from(a), bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}
