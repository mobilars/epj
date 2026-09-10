import { describe, expect, it, vi, afterEach } from 'vitest';
import { base32Decode, base32Encode, newTotpSecret, otpauthUrl, totpCode, verifyTotp } from '../src/lib/server/auth/totp';

describe('base32', () => {
	it('koder og dekoder fram og tilbake', () => {
		const data = Buffer.from('Hei, dette er en hemmelighet');
		expect(base32Decode(base32Encode(data)).toString()).toBe(data.toString());
	});

	it('følger RFC 4648-vektorene', () => {
		expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
	});

	it('avviser ugyldige tegn', () => {
		expect(() => base32Decode('AB1!')).toThrow();
	});
});

describe('TOTP (RFC 6238)', () => {
	// RFC 6238 bruker hemmeligheten "12345678901234567890" (SHA-1).
	const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

	it('gjengir testvektorene fra RFC 6238', () => {
		expect(totpCode(rfcSecret, Math.floor(59 / 30))).toBe('287082');
		expect(totpCode(rfcSecret, Math.floor(1111111109 / 30))).toBe('081804');
		expect(totpCode(rfcSecret, Math.floor(1234567890 / 30))).toBe('005924');
	});

	it('godtar gjeldende kode', () => {
		const h = newTotpSecret();
		expect(verifyTotp(h, totpCode(h))).toBe(true);
	});

	it('godtar kode ett tidssteg bak og fram (klokkeavvik)', () => {
		const h = newTotpSecret();
		const now = Math.floor(Date.now() / 30000);
		expect(verifyTotp(h, totpCode(h, now - 1))).toBe(true);
		expect(verifyTotp(h, totpCode(h, now + 1))).toBe(true);
	});

	it('avviser kode utenfor vinduet', () => {
		const h = newTotpSecret();
		expect(verifyTotp(h, totpCode(h, Math.floor(Date.now() / 30000) - 5))).toBe(false);
	});

	it('avviser feil format', () => {
		const h = newTotpSecret();
		expect(verifyTotp(h, '12345')).toBe(false);
		expect(verifyTotp(h, 'abcdef')).toBe(false);
		expect(verifyTotp(h, '')).toBe(false);
	});

	it('tåler mellomrom i koden', () => {
		const h = newTotpSecret();
		const code = totpCode(h);
		expect(verifyTotp(h, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
	});

	it('lager otpauth-URL som autentiseringsapper forstår', () => {
		const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'lege@legesenteret.no', 'EPJ');
		expect(url).toContain('otpauth://totp/EPJ%3Alege%40legesenteret.no');
		expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
		expect(url).toContain('issuer=EPJ');
	});
});
