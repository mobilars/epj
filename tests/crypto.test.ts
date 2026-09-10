import { describe, expect, it } from 'vitest';
import { decrypt, hashPassword, encrypt, likeStrenger, sha256, tokenHash, verifyPassword } from '../src/lib/server/util/crypto';

describe('kryptering av data at rest', () => {
	it('krypterer og dekrypterer', () => {
		const klartekst = 'JBSWY3DPEHPK3PXP';
		expect(decrypt(encrypt(klartekst))).toBe(klartekst);
	});

	it('gir ulik chiffertekst hver gang (tilfeldig IV)', () => {
		expect(encrypt('samme')).not.toBe(encrypt('samme'));
	});

	it('avviser endret chiffertekst (GCM-autentisering)', () => {
		const c = encrypt('hemmelig');
		const parts = c.split('.');
		parts[3] = Buffer.from('noe helt annet').toString('base64url');
		expect(() => decrypt(parts.join('.'))).toThrow();
	});

	it('avviser ukjent format', () => {
		expect(() => decrypt('v9.a.b.c')).toThrow(/format/i);
	});

	it('håndterer norske tegn og lange verdier', () => {
		const text = 'æøå ÆØÅ – tegn og «hermetegn» '.repeat(200);
		expect(decrypt(encrypt(text))).toBe(text);
	});
});

describe('passordhashing', () => {
	it('verifiserer riktig passord', () => {
		const hash = hashPassword('Testpassord1!');
		expect(verifyPassword('Testpassord1!', hash)).toBe(true);
	});

	it('avviser feil passord', () => {
		const hash = hashPassword('Testpassord1!');
		expect(verifyPassword('Testpassord1', hash)).toBe(false);
		expect(verifyPassword('', hash)).toBe(false);
	});

	it('bruker tilfeldig salt', () => {
		expect(hashPassword('samme')).not.toBe(hashPassword('samme'));
	});

	it('normaliserer unicode, slik at samme tegn gir samme resultat', () => {
		const dekomponert = 'passord̊'; // ring over a
		const komponert = 'passord̊'.normalize('NFKC');
		expect(verifyPassword(komponert, hashPassword(dekomponert))).toBe(true);
	});

	it('avviser ødelagt hash uten å kaste', () => {
		expect(verifyPassword('x', 'ikke-en-hash')).toBe(false);
		expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
	});
});

describe('tokenhashing', () => {
	it('er deterministisk', () => {
		expect(tokenHash('abc')).toBe(tokenHash('abc'));
		expect(tokenHash('abc')).not.toBe(tokenHash('abd'));
	});

	it('lekker ikke tokenet', () => {
		expect(tokenHash('hemmelig-token')).not.toContain('hemmelig');
	});
});

describe('konstanttidssammenlikning', () => {
	it('sammenlikner likt og ulikt', () => {
		expect(likeStrenger('abc', 'abc')).toBe(true);
		expect(likeStrenger('abc', 'abd')).toBe(false);
		expect(likeStrenger('abc', 'abcd')).toBe(false);
	});
});

describe('sha256', () => {
	it('gir base64url uten padding', () => {
		expect(sha256('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
	});
});
