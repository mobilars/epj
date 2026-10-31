import {
	SignJWT,
	calculateJwkThumbprint,
	decodeJwt,
	decodeProtectedHeader,
	errors as joseErrors,
	exportJWK,
	exportPKCS8,
	generateKeyPair as joseGenerateKeyPair,
	importJWK,
	importPKCS8,
	jwtVerify,
	type JWK
} from 'jose';

/**
 * Compact JWS, implemented with `jose`.
 *
 * The record signs its own access tokens and id_tokens, and verifies client
 * assertions and HelseID's id_token. Signing and verification are deliberately
 * left to a maintained JOSE library rather than being written against
 * node:crypto: algorithm confusion, `alg: none` and the ECDSA DER/raw
 * conversion are exactly the places a hand-rolled implementation goes wrong.
 */

export type Algorithm = 'ES256' | 'RS256' | 'PS256';

export interface JwtHeader {
	alg: Algorithm;
	typ?: string;
	kid?: string;
}

/**
 * ES256 is used for the tokens we issue ourselves. RS256/PS256 must be
 * supported because HelseID signs its id_token with RS256, and expects client
 * assertions signed with RS256 or PS256.
 */
const ALLOWED_ALGORITHMS: ReadonlySet<string> = new Set<Algorithm>(['ES256', 'RS256', 'PS256']);

/** JWK with the fields JOSE uses. `JsonWebKey` in lib.dom lacks kid/alg/use. */
export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

export type JwtPayload = Record<string, unknown> & {
	iss?: string;
	sub?: string;
	aud?: string | string[];
	exp?: number;
	iat?: number;
	nbf?: number;
	jti?: string;
};

/**
 * Key id as JWK thumbprint (RFC 7638). The id is then both unique per key and
 * reproducible from the public key alone, and unaffected by extra fields such
 * as `alg` and `use`.
 */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
	return calculateJwkThumbprint(jwk as JWK, 'sha256');
}

export async function generateKeyPair(): Promise<{ privatePkcs8: string; publicJwk: Jwk; kid: string }> {
	const { privateKey, publicKey } = await joseGenerateKeyPair('ES256', { extractable: true });
	const publicJwk = (await exportJWK(publicKey)) as Jwk;
	const kid = await jwkThumbprint(publicJwk);
	return {
		privatePkcs8: await exportPKCS8(privateKey),
		publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
		kid
	};
}

export async function sign(
	payload: JwtPayload,
	privatePem: string,
	kid: string,
	typ = 'JWT',
	alg: Algorithm = 'ES256'
): Promise<string> {
	const key = await importPKCS8(privatePem, alg);
	return new SignJWT(payload).setProtectedHeader({ alg, typ, kid }).sign(key);
}

/**
 * Translates jose's error classes into the messages the record's own error
 * handling and security log use.
 */
function asError(err: unknown): Error {
	if (err instanceof joseErrors.JWTExpired) return new Error('Token has expired');
	if (err instanceof joseErrors.JWTClaimValidationFailed) {
		return new Error(err.claim === 'nbf' ? 'Token is not valid yet' : `Invalid claim: ${err.claim}`);
	}
	if (err instanceof joseErrors.JWSSignatureVerificationFailed) return new Error('The signature is invalid');
	if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
		return new Error('Invalid JWT structure');
	}
	return new Error('The signature is invalid');
}

export async function verify(jwt: string, publicJwks: Jwk[], expectedAlg?: Algorithm): Promise<JwtPayload> {
	if (jwt.split('.').length !== 3) throw new Error('Invalid JWT structure');
	let header: JwtHeader;
	try {
		header = decodeProtectedHeader(jwt) as JwtHeader;
	} catch {
		throw new Error('Invalid JWT structure');
	}
	// `alg` is read from the header but must be on the allowlist. "none", and
	// switching to HMAC with the public key as the secret, are thereby ruled out.
	if (!ALLOWED_ALGORITHMS.has(header.alg)) throw new Error(`The algorithm ${header.alg} is not permitted`);
	if (expectedAlg && header.alg !== expectedAlg) throw new Error(`Expected ${expectedAlg}, got ${header.alg}`);

	const candidates = header.kid ? publicJwks.filter((k) => k.kid === header.kid) : publicJwks;
	if (candidates.length === 0) throw new Error('Unknown key id (kid)');

	let last: unknown;
	for (const jwk of candidates) {
		try {
			const key = await importJWK({ ...jwk, alg: header.alg } as JWK, header.alg);
			// A little slack on `nbf` absorbs clock skew between issuer and record.
			// `exp` is checked strictly below - leniency there would extend the life
			// of a token that has already run out.
			const { payload } = await jwtVerify(jwt, key, { algorithms: [header.alg], clockTolerance: 60 });
			if (typeof payload.exp === 'number' && payload.exp <= Math.floor(Date.now() / 1000)) {
				throw new Error('Token has expired');
			}
			return payload as JwtPayload;
		} catch (err) {
			if (err instanceof Error && err.message === 'Token has expired') throw err;
			last = err;
		}
	}
	throw asError(last);
}

/** Reads the payload without verifying. For logging and debugging only. */
export function decodeWithoutVerification(jwt: string): { header: JwtHeader; payload: JwtPayload } | null {
	try {
		return { header: decodeProtectedHeader(jwt) as JwtHeader, payload: decodeJwt(jwt) as JwtPayload };
	} catch {
		return null;
	}
}
