import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { decodeWithoutVerification, generateNokkelpar, jwkTommelavtrykk, sign, verify, type Jwk } from '../src/lib/server/auth/jws';

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JWS ES256', () => {
	const { privatePkcs8, publicJwk, kid } = generateNokkelpar();

	it('signerer og verifiserer', () => {
		const jwt = sign({ sub: 'bruker-1', iss: 'epj' }, privatePkcs8, kid);
		expect(verify(jwt, [publicJwk])).toMatchObject({ sub: 'bruker-1', iss: 'epj' });
	});

	it('lager tre deler med kid i headeren', () => {
		const jwt = sign({ sub: 'x' }, privatePkcs8, kid, 'at+jwt');
		expect(jwt.split('.')).toHaveLength(3);
		expect(decodeWithoutVerification(jwt)?.header).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid });
	});

	it('avviser endret nyttelast', () => {
		const jwt = sign({ sub: 'bruker-1', roles: ['sykepleier'] }, privatePkcs8, kid);
		const [h, , s] = jwt.split('.');
		const tuklet = `${h}.${b64u({ sub: 'bruker-1', roles: ['lege'] })}.${s}`;
		expect(() => verify(tuklet, [publicJwk])).toThrow(/ugyldig/i);
	});

	it('avviser signatur fra en annen nøkkel', () => {
		const annen = generateNokkelpar();
		const jwt = sign({ sub: 'x' }, annen.privatePkcs8, kid);
		expect(() => verify(jwt, [publicJwk])).toThrow(/ugyldig/i);
	});

	it('avviser ukjent kid', () => {
		const jwt = sign({ sub: 'x' }, privatePkcs8, 'en-annen-kid');
		expect(() => verify(jwt, [publicJwk])).toThrow(/kid/i);
	});

	it('avviser alg=none', () => {
		const tuklet = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ sub: 'angriper' })}.`;
		expect(() => verify(tuklet, [publicJwk])).toThrow(/ikke tillatt/i);
	});

	it('avviser HS256 signert med den offentlige nøkkelen', () => {
		const tuklet = `${b64u({ alg: 'HS256' })}.${b64u({ sub: 'angriper' })}.abc`;
		expect(() => verify(tuklet, [publicJwk])).toThrow(/ikke tillatt/i);
	});

	it('avviser utløpt token', () => {
		const jwt = sign({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, privatePkcs8, kid);
		expect(() => verify(jwt, [publicJwk])).toThrow(/utløpt/i);
	});

	it('avviser token som ikke er gyldig ennå', () => {
		const jwt = sign({ sub: 'x', nbf: Math.floor(Date.now() / 1000) + 600 }, privatePkcs8, kid);
		expect(() => verify(jwt, [publicJwk])).toThrow(/ikke gyldig/i);
	});

	it('avviser feil struktur', () => {
		expect(() => verify('bare.to', [publicJwk])).toThrow(/struktur/i);
	});

	it('gir unik kid per nøkkel', () => {
		const kids = new Set(Array.from({ length: 20 }, () => generateNokkelpar().kid));
		expect(kids.size).toBe(20);
	});

	it('regner kid som RFC 7638-tommelavtrykk, reproduserbart fra den offentlige nøkkelen', () => {
		const par = generateNokkelpar();
		expect(jwkTommelavtrykk(par.publicJwk)).toBe(par.kid);
		// The thumbprint must not be affected by extra fields such as alg and use.
		expect(jwkTommelavtrykk({ ...par.publicJwk, alg: undefined, use: undefined })).toBe(par.kid);
	});
});

describe('JWS RS256 og PS256 (HelseID)', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
	const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1', alg: 'RS256' };

	it('signerer og verifiserer RS256', () => {
		const jwt = sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		expect(verify(jwt, [jwk])).toMatchObject({ sub: 'klient' });
	});

	it('signerer og verifiserer PS256', () => {
		const jwt = sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'PS256');
		expect(verify(jwt, [{ ...jwk, alg: 'PS256' }])).toMatchObject({ sub: 'klient' });
	});

	it('kan kreve en bestemt algoritme', () => {
		const jwt = sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		expect(() => verify(jwt, [jwk], 'ES256')).toThrow(/Forventet ES256/);
	});

	it('avviser RS256-signatur som ikke stemmer', () => {
		const jwt = sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		const [h, p] = jwt.split('.');
		const errorSignatur = createSign('SHA256').update(`${h}.tull`).sign(privateKey).toString('base64url');
		expect(() => verify(`${h}.${p}.${errorSignatur}`, [jwk])).toThrow(/ugyldig/i);
	});
});
