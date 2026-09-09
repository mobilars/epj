import { all, get, run } from '../db';
import { config } from '../config';
import { dekrypter, krypter } from '../util/crypto';
import { naa, omSekunder } from '../util/ids';
import { genererNokkelpar } from './jws';

export interface AktivNokkel {
	kid: string;
	privatePem: string;
}

interface NokkelRad {
	kid: string;
	alg: string;
	public_jwk: string;
	private_enc: string;
	opprettet: string;
	aktiv: number;
	utfases_etter: string | null;
}

/** Henter gjeldende signeringsnøkkel og oppretter/roterer den ved behov. */
export function aktivSigneringsnokkel(): AktivNokkel {
	const rad = get<NokkelRad>('SELECT * FROM signing_key WHERE aktiv = 1 ORDER BY opprettet DESC LIMIT 1');
	if (rad && !forGammel(rad)) {
		return { kid: rad.kid, privatePem: dekrypter(rad.private_enc) };
	}
	return roterNokkel();
}

function forGammel(rad: NokkelRad): boolean {
	const alder = Date.now() - new Date(rad.opprettet).getTime();
	return alder > config.oauth.signingKeyRotationDays * 24 * 3600 * 1000;
}

/**
 * Oppretter ny nøkkel. Gammel nøkkel beholdes i JWKS til utstedte tokens er
 * utløpt, slik at rotasjon ikke gir nedetid for SMART-apper.
 */
export function roterNokkel(): AktivNokkel {
	const { privatePkcs8, publicJwk, kid } = genererNokkelpar();
	run('UPDATE signing_key SET aktiv = 0, utfases_etter = ? WHERE aktiv = 1', omSekunder(config.oauth.accessTokenTtl * 2));
	run(
		'INSERT INTO signing_key (kid, alg, public_jwk, private_enc, opprettet, aktiv) VALUES (?,?,?,?,?,1)',
		kid, 'ES256', JSON.stringify(publicJwk), krypter(privatePkcs8), naa()
	);
	return { kid, privatePem: privatePkcs8 };
}

/** Alle offentlige nøkler som fortsatt kan verifisere utstedte tokens. */
export function jwks(): { keys: JsonWebKey[] } {
	const rader = all<NokkelRad>(
		"SELECT * FROM signing_key WHERE aktiv = 1 OR utfases_etter IS NULL OR utfases_etter > datetime('now') ORDER BY opprettet DESC"
	);
	if (rader.length === 0) {
		aktivSigneringsnokkel();
		return jwks();
	}
	return { keys: rader.map((r) => JSON.parse(r.public_jwk) as JsonWebKey) };
}

/** Rydder bort nøkler som ikke lenger kan verifisere gyldige tokens. */
export function fjernUtdaterteNokler(): number {
	return run("DELETE FROM signing_key WHERE aktiv = 0 AND utfases_etter IS NOT NULL AND utfases_etter < datetime('now', '-1 day')").changes;
}
