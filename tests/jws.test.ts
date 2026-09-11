import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { decodeWithoutVerification, generateKeyPair, jwkThumbprint, sign, verify, type Jwk } from '../src/lib/server/auth/jws';

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JWS ES256', async () => {
	const { privatePkcs8, publicJwk, kid } = await generateKeyPair();

	it('signs and verifies', async () => {
		const jwt = await sign({ sub: 'bruker-1', iss: 'epj' }, privatePkcs8, kid);
		await expect(verify(jwt, [publicJwk])).resolves.toMatchObject({ sub: 'bruker-1', iss: 'epj' });
	});

	it('produces three parts with kid in the header', async () => {
		const jwt = await sign({ sub: 'x' }, privatePkcs8, kid, 'at+jwt');
		expect(jwt.split('.')).toHaveLength(3);
		expect(decodeWithoutVerification(jwt)?.header).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid });
	});

	it('rejects an altered payload', async () => {
		const jwt = await sign({ sub: 'bruker-1', roles: ['resepsjon'] }, privatePkcs8, kid);
		const [h, , s] = jwt.split('.');
		// A different payload, or the test proves nothing: the point is that the
		// signature no longer matches what it was made over.
		const tampered = `${h}.${b64u({ sub: 'bruker-1', roles: ['behandler'] })}.${s}`;
		await expect(verify(tampered, [publicJwk])).rejects.toThrow(/invalid/i);
	});

	it('rejects a signature from another key', async () => {
		const other = await generateKeyPair();
		const jwt = await sign({ sub: 'x' }, other.privatePkcs8, kid);
		await expect(verify(jwt, [publicJwk])).rejects.toThrow(/invalid/i);
	});

	it('rejects an unknown kid', async () => {
		const jwt = await sign({ sub: 'x' }, privatePkcs8, 'another-kid');
		await expect(verify(jwt, [publicJwk])).rejects.toThrow(/kid/i);
	});

	it('rejects alg=none', async () => {
		const tampered = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ sub: 'angriper' })}.`;
		await expect(verify(tampered, [publicJwk])).rejects.toThrow(/not permitted/i);
	});

	it('rejects HS256 signed with the public key', async () => {
		const tampered = `${b64u({ alg: 'HS256' })}.${b64u({ sub: 'angriper' })}.abc`;
		await expect(verify(tampered, [publicJwk])).rejects.toThrow(/not permitted/i);
	});

	it('rejects an expired token', async () => {
		const jwt = await sign({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, privatePkcs8, kid);
		await expect(verify(jwt, [publicJwk])).rejects.toThrow(/expired/i);
	});

	it('rejects a token that is not valid yet', async () => {
		const jwt = await sign({ sub: 'x', nbf: Math.floor(Date.now() / 1000) + 600 }, privatePkcs8, kid);
		await expect(verify(jwt, [publicJwk])).rejects.toThrow(/not valid yet/i);
	});

	it('rejects a malformed structure', async () => {
		await expect(verify('bare.to', [publicJwk])).rejects.toThrow(/structure/i);
	});

	it('gives a unique kid per key', async () => {
		const kids = new Set(await Promise.all(Array.from({ length: 20 }, async () => (await generateKeyPair()).kid)));
		expect(kids.size).toBe(20);
	});

	it('computes kid as an RFC 7638 thumbprint, reproducible from the public key', async () => {
		const pair = await generateKeyPair();
		await expect(jwkThumbprint(pair.publicJwk)).resolves.toBe(pair.kid);
		// The thumbprint must not be affected by extra fields such as alg and use.
		await expect(jwkThumbprint({ ...pair.publicJwk, alg: undefined, use: undefined })).resolves.toBe(pair.kid);
	});
});

describe('JWS RS256 and PS256 (HelseID)', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
	const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1', alg: 'RS256' };

	it('signs and verifies RS256', async () => {
		const jwt = await sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		await expect(verify(jwt, [jwk])).resolves.toMatchObject({ sub: 'klient' });
	});

	it('signs and verifies PS256', async () => {
		const jwt = await sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'PS256');
		await expect(verify(jwt, [{ ...jwk, alg: 'PS256' }])).resolves.toMatchObject({ sub: 'klient' });
	});

	it('can require a specific algorithm', async () => {
		const jwt = await sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		await expect(verify(jwt, [jwk], 'ES256')).rejects.toThrow(/Expected ES256/);
	});

	it('rejects an RS256 signature that does not match', async () => {
		const jwt = await sign({ sub: 'klient' }, pem, 'rsa-1', 'JWT', 'RS256');
		const [h, p] = jwt.split('.');
		const wrongSignature = createSign('SHA256').update(`${h}.tull`).sign(privateKey).toString('base64url');
		await expect(verify(`${h}.${p}.${wrongSignature}`, [jwk])).rejects.toThrow(/invalid/i);
	});
});
