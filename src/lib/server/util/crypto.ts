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

function masterKey(): Buffer {
	// EPJ_DATA_KEY strekkes til 32 byte med en fast, applikasjonsspesifikk salt.
	return scryptSync(config.dataEncryptionKey, 'epj-data-key-v1', KEY_LEN);
}

/** AES-256-GCM. Format: v1.<iv>.<tag>.<ciphertext>, alle deler base64url. */
export function krypter(klartekst: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([cipher.update(klartekst, 'utf8'), cipher.final()]);
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function dekrypter(chiffertekst: string): string {
	const [versjon, ivB64, tagB64, ctB64] = chiffertekst.split('.');
	if (versjon !== 'v1') throw new Error('Ukjent krypteringsformat');
	const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64url'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Passordhashing med scrypt. Format: scrypt$N$r$p$salt$hash */
export function hashPassord(passord: string): string {
	const N = 16384, r = 8, p = 1;
	const salt = randomBytes(16);
	const hash = scryptSync(passord.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
	return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifiserPassord(passord: string, lagret: string): boolean {
	try {
		const [alg, N, r, p, saltB64, hashB64] = lagret.split('$');
		if (alg !== 'scrypt') return false;
		const salt = Buffer.from(saltB64, 'base64url');
		const forventet = Buffer.from(hashB64, 'base64url');
		const faktisk = scryptSync(passord.normalize('NFKC'), salt, forventet.length, {
			N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
		});
		return timingSafeEqual(forventet, faktisk);
	} catch {
		return false;
	}
}

/** Hash for oppslag av tokens. Tokens lagres aldri i klartekst. */
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
