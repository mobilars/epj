import { constants, createHash, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * Kompakt JWS med ES256 (ECDSA P-256 + SHA-256), implementert direkte mot
 * node:crypto. Node signerer ECDSA i DER-format; JOSE krever rå R||S, så vi
 * konverterer begge veier.
 */

export type Algoritme = 'ES256' | 'RS256' | 'PS256';

export interface JwtHeader {
	alg: Algoritme;
	typ?: string;
	kid?: string;
}

/**
 * ES256 brukes for tokens vi selv utsteder. RS256/PS256 må støttes fordi HelseID
 * signerer sine id_token med RS256, og forventer klientassertions signert med
 * RS256 eller PS256.
 */
const ALLOWED_ALGORITMER: ReadonlySet<string> = new Set(['ES256', 'RS256', 'PS256']);

function signeringsopsjoner(alg: Algoritme): { hash: string; padding?: number; saltLength?: number } {
	if (alg === 'PS256') {
		return { hash: 'SHA256', padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
	}
	return { hash: 'SHA256' };
}

/** JWK med de feltene JOSE bruker. `JsonWebKey` i lib.dom mangler kid/alg/use. */
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

const b64u = (b: Buffer | string): string => Buffer.from(b as never).toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/**
 * Nøkkel-id som JWK-tommelavtrykk (RFC 7638): SHA-256 over en kanonisk JSON med
 * bare de påkrevde feltene, i leksikografisk rekkefølge. Da blir id-en både
 * unik per nøkkel og reproduserbar fra den offentlige nøkkelen alene.
 */
export function jwkTommelavtrykk(jwk: Jwk): string {
	const kanonisk =
		jwk.kty === 'EC'
			? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
			: JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
	return createHash('sha256').update(kanonisk).digest('base64url');
}

export function generateNokkelpar(): { privatePkcs8: string; publicJwk: Jwk; kid: string } {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = publicKey.export({ format: 'jwk' }) as Jwk;
	const kid = jwkTommelavtrykk(publicJwk);
	return {
		privatePkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
		publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
		kid
	};
}

/** DER (SEQUENCE av to INTEGER) -> rå R||S på 64 byte. */
function derToRaw(der: Buffer): Buffer {
	let offset = 2;
	if (der[1] & 0x80) offset += der[1] & 0x7f;
	const read = (): Buffer => {
		if (der[offset] !== 0x02) throw new Error('Ugyldig DER-signatur');
		const len = der[offset + 1];
		const start = offset + 2;
		offset = start + len;
		let v = der.subarray(start, start + len);
		while (v.length > 32 && v[0] === 0) v = v.subarray(1);
		return Buffer.concat([Buffer.alloc(32 - v.length), v]);
	};
	return Buffer.concat([read(), read()]);
}

function rawToDer(raw: Buffer): Buffer {
	const trim = (b: Buffer): Buffer => {
		let i = 0;
		while (i < b.length - 1 && b[i] === 0) i++;
		let v = b.subarray(i);
		if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
		return v;
	};
	const r = trim(raw.subarray(0, 32));
	const s = trim(raw.subarray(32, 64));
	const body = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
	return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export function sign(
	payload: JwtPayload,
	privatePem: string,
	kid: string,
	typ = 'JWT',
	alg: Algoritme = 'ES256'
): string {
	const header: JwtHeader = { alg, typ, kid };
	const signeringsinput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
	const key: KeyObject = createPrivateKey(privatePem);
	const options = signeringsopsjoner(alg);
	const signatur = createSign(options.hash).update(signeringsinput).sign(
		alg === 'PS256' ? { key, padding: options.padding, saltLength: options.saltLength } : key
	);
	return `${signeringsinput}.${b64u(alg === 'ES256' ? derToRaw(signatur) : signatur)}`;
}

export function verify(jwt: string, publicJwks: Jwk[], expectedAlg?: Algoritme): JwtPayload {
	const parts = jwt.split('.');
	if (parts.length !== 3) throw new Error('Ugyldig JWT-struktur');
	const [h, p, s] = parts;
	const header = JSON.parse(fromB64u(h).toString('utf8')) as JwtHeader;
	// `alg` leses fra headeren, men må stå på tillatelseslisten. «none» og
	// bytte til HMAC med den offentlige nøkkelen som hemmelighet er dermed utelukket.
	if (!ALLOWED_ALGORITMER.has(header.alg)) throw new Error(`Algoritmen ${header.alg} er ikke tillatt`);
	if (expectedAlg && header.alg !== expectedAlg) throw new Error(`Forventet ${expectedAlg}, fikk ${header.alg}`);
	const candidates = header.kid ? publicJwks.filter((k) => k.kid === header.kid) : publicJwks;
	if (candidates.length === 0) throw new Error('Ukjent nøkkel-id (kid)');
	const raw = fromB64u(s);
	const signatur = header.alg === 'ES256' ? rawToDer(raw) : raw;
	const options = signeringsopsjoner(header.alg);
	const ok = candidates.some((jwk) => {
		try {
			const key = createPublicKey({ key: jwk as never, format: 'jwk' });
			return createVerify(options.hash)
				.update(`${h}.${p}`)
				.verify(header.alg === 'PS256' ? { key, padding: options.padding, saltLength: options.saltLength } : key, signatur);
		} catch {
			return false;
		}
	});
	if (!ok) throw new Error('Signaturen er ugyldig');
	const payload = JSON.parse(fromB64u(p).toString('utf8')) as JwtPayload;
	const now = Math.floor(Date.now() / 1000);
	if (typeof payload.exp === 'number' && payload.exp <= now) throw new Error('Token er utløpt');
	if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new Error('Token er ikke gyldig ennå');
	return payload;
}

/** Leser payload uten å verifisere. Kun for logging og feilsøking. */
export function decodeWithoutVerification(jwt: string): { header: JwtHeader; payload: JwtPayload } | null {
	try {
		const [h, p] = jwt.split('.');
		return {
			header: JSON.parse(fromB64u(h).toString('utf8')),
			payload: JSON.parse(fromB64u(p).toString('utf8'))
		};
	} catch {
		return null;
	}
}
