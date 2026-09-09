import { constants, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';

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
const TILLATTE_ALGORITMER: ReadonlySet<string> = new Set(['ES256', 'RS256', 'PS256']);

function signeringsopsjoner(alg: Algoritme): { hash: string; padding?: number; saltLength?: number } {
	if (alg === 'PS256') {
		return { hash: 'SHA256', padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
	}
	return { hash: 'SHA256' };
}

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
const fraB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export function genererNokkelpar(): { privatePkcs8: string; publicJwk: JsonWebKey; kid: string } {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
	const kid = b64u(Buffer.from(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })))
		.slice(0, 22);
	return {
		privatePkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
		publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
		kid
	};
}

/** DER (SEQUENCE av to INTEGER) -> rå R||S på 64 byte. */
function derTilRaw(der: Buffer): Buffer {
	let offset = 2;
	if (der[1] & 0x80) offset += der[1] & 0x7f;
	const les = (): Buffer => {
		if (der[offset] !== 0x02) throw new Error('Ugyldig DER-signatur');
		const len = der[offset + 1];
		const start = offset + 2;
		offset = start + len;
		let v = der.subarray(start, start + len);
		while (v.length > 32 && v[0] === 0) v = v.subarray(1);
		return Buffer.concat([Buffer.alloc(32 - v.length), v]);
	};
	return Buffer.concat([les(), les()]);
}

function rawTilDer(raw: Buffer): Buffer {
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

export function signer(
	payload: JwtPayload,
	privatePem: string,
	kid: string,
	typ = 'JWT',
	alg: Algoritme = 'ES256'
): string {
	const header: JwtHeader = { alg, typ, kid };
	const signeringsinput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
	const key: KeyObject = createPrivateKey(privatePem);
	const opsjoner = signeringsopsjoner(alg);
	const signatur = createSign(opsjoner.hash).update(signeringsinput).sign(
		alg === 'PS256' ? { key, padding: opsjoner.padding, saltLength: opsjoner.saltLength } : key
	);
	return `${signeringsinput}.${b64u(alg === 'ES256' ? derTilRaw(signatur) : signatur)}`;
}

export function verifiser(jwt: string, publicJwks: JsonWebKey[], forventetAlg?: Algoritme): JwtPayload {
	const deler = jwt.split('.');
	if (deler.length !== 3) throw new Error('Ugyldig JWT-struktur');
	const [h, p, s] = deler;
	const header = JSON.parse(fraB64u(h).toString('utf8')) as JwtHeader;
	// `alg` leses fra headeren, men må stå på tillatelseslisten. «none» og
	// bytte til HMAC med den offentlige nøkkelen som hemmelighet er dermed utelukket.
	if (!TILLATTE_ALGORITMER.has(header.alg)) throw new Error(`Algoritmen ${header.alg} er ikke tillatt`);
	if (forventetAlg && header.alg !== forventetAlg) throw new Error(`Forventet ${forventetAlg}, fikk ${header.alg}`);
	const kandidater = header.kid ? publicJwks.filter((k) => (k as { kid?: string }).kid === header.kid) : publicJwks;
	if (kandidater.length === 0) throw new Error('Ukjent nøkkel-id (kid)');
	const rå = fraB64u(s);
	const signatur = header.alg === 'ES256' ? rawTilDer(rå) : rå;
	const opsjoner = signeringsopsjoner(header.alg);
	const ok = kandidater.some((jwk) => {
		try {
			const key = createPublicKey({ key: jwk as never, format: 'jwk' });
			return createVerify(opsjoner.hash)
				.update(`${h}.${p}`)
				.verify(header.alg === 'PS256' ? { key, padding: opsjoner.padding, saltLength: opsjoner.saltLength } : key, signatur);
		} catch {
			return false;
		}
	});
	if (!ok) throw new Error('Signaturen er ugyldig');
	const payload = JSON.parse(fraB64u(p).toString('utf8')) as JwtPayload;
	const nå = Math.floor(Date.now() / 1000);
	if (typeof payload.exp === 'number' && payload.exp <= nå) throw new Error('Token er utløpt');
	if (typeof payload.nbf === 'number' && payload.nbf > nå + 60) throw new Error('Token er ikke gyldig ennå');
	return payload;
}

/** Leser payload uten å verifisere. Kun for logging og feilsøking. */
export function dekodUtenVerifisering(jwt: string): { header: JwtHeader; payload: JwtPayload } | null {
	try {
		const [h, p] = jwt.split('.');
		return {
			header: JSON.parse(fraB64u(h).toString('utf8')),
			payload: JSON.parse(fraB64u(p).toString('utf8'))
		};
	} catch {
		return null;
	}
}
