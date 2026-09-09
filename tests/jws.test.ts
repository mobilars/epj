import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { dekodUtenVerifisering, genererNokkelpar, signer, verifiser, type Jwk } from '../src/lib/server/auth/jws';

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JWS ES256', () => {
	const { privatePkcs8, publicJwk, kid } = genererNokkelpar();

	it('signerer og verifiserer', () => {
		const jwt = signer({ sub: 'bruker-1', iss: 'epj' }, privatePkcs8, kid);
		expect(verifiser(jwt, [publicJwk])).toMatchObject({ sub: 'bruker-1', iss: 'epj' });
	});

	it('lager tre deler med kid i headeren', () => {
		const jwt = signer({ sub: 'x' }, privatePkcs8, kid, 'at+jwt');
		expect(jwt.split('.')).toHaveLength(3);
		expect(dekodUtenVerifisering(jwt)?.header).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid });
	});

	it('avviser endret nyttelast', () => {
		const jwt = signer({ sub: 'bruker-1', roller: ['sykepleier'] }, privatePkcs8, kid);
		const [h, , s] = jwt.split('.');
		const tuklet = `${h}.${b64u({ sub: 'bruker-1', roller: ['lege'] })}.${s}`;
		expect(() => verifiser(tuklet, [publicJwk])).toThrow(/ugyldig/i);
	});

	it('avviser signatur fra en annen nøkkel', () => {
		const annen = genererNokkelpar();
		const jwt = signer({ sub: 'x' }, annen.privatePkcs8, kid);
		expect(() => verifiser(jwt, [publicJwk])).toThrow(/ugyldig/i);
	});

	it('avviser ukjent kid', () => {
		const jwt = signer({ sub: 'x' }, privatePkcs8, 'en-annen-kid');
		expect(() => verifiser(jwt, [publicJwk])).toThrow(/kid/i);
	});

	it('avviser alg=none', () => {
		const tuklet = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ sub: 'angriper' })}.`;
		expect(() => verifiser(tuklet, [publicJwk])).toThrow(/ikke tillatt/i);
	});

	it('avviser HS256 signert med den offentlige nøkkelen', () => {
		const tuklet = `${b64u({ alg: 'HS256' })}.${b64u({ sub: 'angriper' })}.abc`;
		expect(() => verifiser(tuklet, [publicJwk])).toThrow(/ikke tillatt/i);
	});

	it('avviser utløpt token', () => {
		const jwt = signer({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, privatePkcs8, kid);
		expect(() => verifiser(jwt, [publicJwk])).toThrow(/utløpt/i);
	});

	it('avviser token som ikke er gyldig ennå', () => {
		const jwt = signer({ sub: 'x', nbf: Math.floor(Date.now() / 1000) + 600 }, privatePkcs8, kid);
		expect(() => verifiser(jwt, [publicJwk])).toThrow(/ikke gyldig/i);
	});

	it('avviser feil struktur', () => {
		expect(() => verifiser('bare.to', [publicJwk])).toThrow(/struktur/i);
	});
});

describe('JWS RS256 og PS256 (HelseID)', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
	const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1', alg: 'RS256' };

	it('signerer og verifiserer RS256', () => {
		const jwt = signer({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		expect(verifiser(jwt, [jwk])).toMatchObject({ sub: 'klient' });
	});

	it('signerer og verifiserer PS256', () => {
		const jwt = signer({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'PS256');
		expect(verifiser(jwt, [{ ...jwk, alg: 'PS256' }])).toMatchObject({ sub: 'klient' });
	});

	it('kan kreve en bestemt algoritme', () => {
		const jwt = signer({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		expect(() => verifiser(jwt, [jwk], 'ES256')).toThrow(/Forventet ES256/);
	});

	it('avviser RS256-signatur som ikke stemmer', () => {
		const jwt = signer({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		const [h, p] = jwt.split('.');
		const feilSignatur = createSign('SHA256').update(`${h}.tull`).sign(privateKey).toString('base64url');
		expect(() => verifiser(`${h}.${p}.${feilSignatur}`, [jwk])).toThrow(/ugyldig/i);
	});
});
