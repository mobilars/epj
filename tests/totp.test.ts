import { describe, expect, it, vi, afterEach } from 'vitest';
import { base32Dekod, base32Enkod, nyTotpHemmelighet, otpauthUrl, totpKode, verifiserTotp } from '../src/lib/server/auth/totp';

describe('base32', () => {
	it('koder og dekoder fram og tilbake', () => {
		const data = Buffer.from('Hei, dette er en hemmelighet');
		expect(base32Dekod(base32Enkod(data)).toString()).toBe(data.toString());
	});

	it('følger RFC 4648-vektorene', () => {
		expect(base32Enkod(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
	});

	it('avviser ugyldige tegn', () => {
		expect(() => base32Dekod('AB1!')).toThrow();
	});
});

describe('TOTP (RFC 6238)', () => {
	// RFC 6238 bruker hemmeligheten "12345678901234567890" (SHA-1).
	const rfcHemmelighet = base32Enkod(Buffer.from('12345678901234567890'));

	it('gjengir testvektorene fra RFC 6238', () => {
		expect(totpKode(rfcHemmelighet, Math.floor(59 / 30))).toBe('287082');
		expect(totpKode(rfcHemmelighet, Math.floor(1111111109 / 30))).toBe('081804');
		expect(totpKode(rfcHemmelighet, Math.floor(1234567890 / 30))).toBe('005924');
	});

	it('godtar gjeldende kode', () => {
		const h = nyTotpHemmelighet();
		expect(verifiserTotp(h, totpKode(h))).toBe(true);
	});

	it('godtar kode ett tidssteg bak og fram (klokkeavvik)', () => {
		const h = nyTotpHemmelighet();
		const nå = Math.floor(Date.now() / 30000);
		expect(verifiserTotp(h, totpKode(h, nå - 1))).toBe(true);
		expect(verifiserTotp(h, totpKode(h, nå + 1))).toBe(true);
	});

	it('avviser kode utenfor vinduet', () => {
		const h = nyTotpHemmelighet();
		expect(verifiserTotp(h, totpKode(h, Math.floor(Date.now() / 30000) - 5))).toBe(false);
	});

	it('avviser feil format', () => {
		const h = nyTotpHemmelighet();
		expect(verifiserTotp(h, '12345')).toBe(false);
		expect(verifiserTotp(h, 'abcdef')).toBe(false);
		expect(verifiserTotp(h, '')).toBe(false);
	});

	it('tåler mellomrom i koden', () => {
		const h = nyTotpHemmelighet();
		const kode = totpKode(h);
		expect(verifiserTotp(h, `${kode.slice(0, 3)} ${kode.slice(3)}`)).toBe(true);
	});

	it('lager otpauth-URL som autentiseringsapper forstår', () => {
		const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'lege@legesenteret.no', 'EPJ');
		expect(url).toContain('otpauth://totp/EPJ%3Alege%40legesenteret.no');
		expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
		expect(url).toContain('issuer=EPJ');
	});
});
