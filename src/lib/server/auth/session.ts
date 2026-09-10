import type { Cookies } from '@sveltejs/kit';
import { en, exec } from '../db';
import { krevTenant } from '../tenant/kontekst';
import { config } from '../config';
import { nyId, nyToken } from '../util/ids';
import { tokenHash } from '../util/crypto';

export interface Sesjon {
	id: string;
	user_id: string;
	opprettet: string;
	sist_aktiv: string;
	utloper: string;
	amr: string | null;
	elevert_til: string | null;
	ip: string | null;
}

/**
 * Innloggingssesjoner for journalens eget grensesnitt.
 *
 * Cookien er HttpOnly, SameSite=Strict og Secure utenfor lokal utvikling, og
 * inneholder kun et tilfeldig token - aldri brukerdata. Sesjonen har både en
 * inaktivitetsgrense og en absolutt levetid.
 */
export async function opprettSesjon(
	userId: string,
	amr: string,
	ip: string,
	userAgent: string | null,
	cookies: Cookies
): Promise<string> {
	const id = nyId();
	const token = nyToken(32);
	const utloper = new Date(Date.now() + config.session.absoluteSeconds * 1000).toISOString();
	await exec(
		'INSERT INTO user_session (id, token_hash, user_id, utloper, ip, user_agent, amr) VALUES ($1,$2,$3,$4,$5,$6,$7)',
		[id, tokenHash(token), userId, utloper, ip, userAgent, amr]
	);
	cookies.set(config.session.cookieName, `${id}.${token}`, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: config.security.httpsOnly,
		maxAge: config.session.absoluteSeconds
	});
	return id;
}

export async function hentSesjon(cookies: Cookies): Promise<Sesjon | null> {
	const rå = cookies.get(config.session.cookieName);
	if (!rå) return null;
	const skille = rå.indexOf('.');
	if (skille < 0) return null;
	const id = rå.slice(0, skille);
	const token = rå.slice(skille + 1);

	// Sesjonen må tilhøre en bruker i virksomheten forespørselen gjelder. En
	// gyldig sesjonscookie fra ett legekontor skal ikke virke hos et annet.
	const rad = await en<Sesjon & { token_hash: string }>(
		`SELECT s.id, s.user_id, s.opprettet, s.sist_aktiv, s.utloper, s.amr, s.elevert_til, s.ip, s.token_hash
		 FROM user_session s
		 JOIN user_account u ON u.id = s.user_id
		 WHERE s.id = $1 AND s.avsluttet = false AND u.tenant_id IS NOT DISTINCT FROM $2`,
		[id, krevTenant().id]
	);
	if (!rad) return null;
	if (rad.token_hash !== tokenHash(token)) {
		// Gyldig sesjons-id med feil token: mulig tyveri av cookie. Avslutt sesjonen.
		await exec('UPDATE user_session SET avsluttet = true WHERE id = $1', [id]);
		return null;
	}
	if (new Date(rad.utloper).getTime() <= Date.now()) {
		await exec('UPDATE user_session SET avsluttet = true WHERE id = $1', [id]);
		return null;
	}
	const inaktivMs = Date.now() - new Date(rad.sist_aktiv).getTime();
	if (inaktivMs > config.session.idleSeconds * 1000) {
		await exec('UPDATE user_session SET avsluttet = true WHERE id = $1', [id]);
		return null;
	}
	await exec('UPDATE user_session SET sist_aktiv = now() WHERE id = $1', [id]);
	return rad;
}

export async function avsluttSesjon(cookies: Cookies): Promise<void> {
	const rå = cookies.get(config.session.cookieName);
	if (rå) {
		const id = rå.split('.')[0];
		await exec('UPDATE user_session SET avsluttet = true WHERE id = $1', [id]);
	}
	cookies.delete(config.session.cookieName, { path: '/' });
}

/** Markerer sesjonen som nylig reautentisert (step-up), f.eks. før nødrett. */
export async function eleverSesjon(sesjonId: string): Promise<string> {
	const til = new Date(Date.now() + config.session.elevationSeconds * 1000).toISOString();
	await exec('UPDATE user_session SET elevert_til = $2 WHERE id = $1', [sesjonId, til]);
	return til;
}

export async function avsluttAlleSesjoner(userId: string): Promise<number> {
	return exec('UPDATE user_session SET avsluttet = true WHERE user_id = $1 AND avsluttet = false', [userId]);
}

/** Vedlikehold. Går bevisst på tvers av virksomheter: sletter bare utløpte rader. */
export async function ryddUtlopteSesjoner(): Promise<number> {
	return exec("DELETE FROM user_session WHERE utloper < now() - interval '30 days'");
}
