import { describe, expect, it } from 'vitest';
import { dekrypter, hashPassord, krypter, likeStrenger, sha256, tokenHash, verifiserPassord } from '../src/lib/server/util/crypto';

describe('kryptering av data at rest', () => {
	it('krypterer og dekrypterer', () => {
		const klartekst = 'JBSWY3DPEHPK3PXP';
		expect(dekrypter(krypter(klartekst))).toBe(klartekst);
	});

	it('gir ulik chiffertekst hver gang (tilfeldig IV)', () => {
		expect(krypter('samme')).not.toBe(krypter('samme'));
	});

	it('avviser endret chiffertekst (GCM-autentisering)', () => {
		const c = krypter('hemmelig');
		const deler = c.split('.');
		deler[3] = Buffer.from('noe helt annet').toString('base64url');
		expect(() => dekrypter(deler.join('.'))).toThrow();
	});

	it('avviser ukjent format', () => {
		expect(() => dekrypter('v9.a.b.c')).toThrow(/format/i);
	});

	it('håndterer norske tegn og lange verdier', () => {
		const tekst = 'æøå ÆØÅ – tegn og «hermetegn» '.repeat(200);
		expect(dekrypter(krypter(tekst))).toBe(tekst);
	});
});

describe('passordhashing', () => {
	it('verifiserer riktig passord', () => {
		const hash = hashPassord('Testpassord1!');
		expect(verifiserPassord('Testpassord1!', hash)).toBe(true);
	});

	it('avviser feil passord', () => {
		const hash = hashPassord('Testpassord1!');
		expect(verifiserPassord('Testpassord1', hash)).toBe(false);
		expect(verifiserPassord('', hash)).toBe(false);
	});

	it('bruker tilfeldig salt', () => {
		expect(hashPassord('samme')).not.toBe(hashPassord('samme'));
	});

	it('normaliserer unicode, slik at samme tegn gir samme resultat', () => {
		const dekomponert = 'passord̊'; // ring over a
		const komponert = 'passord̊'.normalize('NFKC');
		expect(verifiserPassord(komponert, hashPassord(dekomponert))).toBe(true);
	});

	it('avviser ødelagt hash uten å kaste', () => {
		expect(verifiserPassord('x', 'ikke-en-hash')).toBe(false);
		expect(verifiserPassord('x', 'bcrypt$1$2$3$4$5')).toBe(false);
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
