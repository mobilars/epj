import { en, exec, query, transaction } from '../db';
import { krevTenant } from '../tenant/kontekst';
import { config } from '../config';
import { dekrypter, hashPassord, krypter, verifiserPassord } from '../util/crypto';
import { nyId } from '../util/ids';
import { erRolle, rettigheterForRoller, scopesForRoller, type Rettighet, type Rolle } from '../authz/roles';
import { verifiserTotp } from './totp';

export interface Bruker {
	id: string;
	tenant_id: string | null;
	brukernavn: string;
	navn: string;
	epost: string | null;
	hpr_nummer: string | null;
	practitioner_id: string | null;
	mfa_aktivert: boolean;
	status: string;
	ma_bytte_passord: boolean;
	feilede_forsok: number;
	laast_til: string | null;
	siste_innlogging: string | null;
}

const BRUKERFELT = `id, tenant_id, brukernavn, navn, epost, hpr_nummer, practitioner_id, mfa_aktivert,
	status, ma_bytte_passord, feilede_forsok, laast_til, siste_innlogging`;

export async function hentBruker(id: string): Promise<Bruker | null> {
	return en<Bruker>(`SELECT ${BRUKERFELT} FROM user_account WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2`, [
		id, krevTenant().id
	]);
}

/** Slår opp en bruker uten virksomhetsavgrensning. Kun for plattformpålogging. */
export async function hentBrukerPaTversAvVirksomheter(id: string): Promise<Bruker | null> {
	return en<Bruker>(`SELECT ${BRUKERFELT} FROM user_account WHERE id = $1`, [id]);
}

export async function hentBrukerVedBrukernavn(brukernavn: string): Promise<Bruker | null> {
	return en<Bruker>(
		`SELECT ${BRUKERFELT} FROM user_account WHERE lower(brukernavn) = lower($1) AND tenant_id IS NOT DISTINCT FROM $2`,
		[brukernavn, krevTenant().id]
	);
}

export async function listBrukere(): Promise<(Bruker & { roller: Rolle[] })[]> {
	const tenantId = krevTenant().id;
	const brukere = await query<Bruker>(
		`SELECT ${BRUKERFELT} FROM user_account WHERE tenant_id IS NOT DISTINCT FROM $1 ORDER BY navn`,
		[tenantId]
	);
	const roller = await query<{ user_id: string; rolle: string }>(
		`SELECT r.user_id, r.rolle FROM role_assignment r
		 JOIN user_account u ON u.id = r.user_id
		 WHERE u.tenant_id IS NOT DISTINCT FROM $1
		   AND r.gyldig_fra <= now() AND (r.gyldig_til IS NULL OR r.gyldig_til > now())`,
		[tenantId]
	);
	const kart = new Map<string, Rolle[]>();
	for (const r of roller) {
		if (!erRolle(r.rolle)) continue;
		kart.set(r.user_id, [...(kart.get(r.user_id) ?? []), r.rolle]);
	}
	return brukere.map((b) => ({ ...b, roller: kart.get(b.id) ?? [] }));
}

export async function rollerFor(userId: string): Promise<Rolle[]> {
	// Rollen henger på brukeren, som allerede er virksomhetsavgrenset.
	const rader = await query<{ rolle: string }>(
		`SELECT rolle FROM role_assignment
		 WHERE user_id = $1 AND gyldig_fra <= now() AND (gyldig_til IS NULL OR gyldig_til > now())`,
		[userId]
	);
	return rader.map((r) => r.rolle).filter(erRolle);
}

export interface NyBruker {
	brukernavn: string;
	navn: string;
	epost?: string;
	hprNummer?: string;
	practitionerId?: string;
	passord?: string;
	roller: Rolle[];
	opprettetAv?: string;
	/** `null` gir en plattformadministrator uten virksomhet. */
	tenantId?: string | null;
}

export async function opprettBruker(inn: NyBruker): Promise<Bruker> {
	return transaction(async () => {
		const id = nyId();
		await exec(
			`INSERT INTO user_account (id, tenant_id, brukernavn, navn, epost, hpr_nummer, practitioner_id, passord_hash, ma_bytte_passord)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			[
				id, inn.tenantId === undefined ? krevTenant().id : inn.tenantId,
				inn.brukernavn, inn.navn, inn.epost ?? null, inn.hprNummer ?? null,
				inn.practitionerId ?? null, inn.passord ? hashPassord(inn.passord) : null, inn.passord ? true : false
			]
		);
		for (const rolle of inn.roller) {
			await exec('INSERT INTO role_assignment (id, user_id, rolle, tildelt_av) VALUES ($1,$2,$3,$4)', [
				nyId(), id, rolle, inn.opprettetAv ?? null
			]);
		}
		const bruker = await hentBrukerPaTversAvVirksomheter(id);
		if (!bruker) throw new Error('Klarte ikke å opprette bruker');
		return bruker;
	});
}

export async function settRoller(userId: string, roller: Rolle[], tildeltAv: string): Promise<void> {
	await krevSammeVirksomhet(userId);
	await transaction(async () => {
		await exec('UPDATE role_assignment SET gyldig_til = now() WHERE user_id = $1 AND gyldig_til IS NULL', [userId]);
		for (const rolle of roller) {
			await exec('INSERT INTO role_assignment (id, user_id, rolle, tildelt_av) VALUES ($1,$2,$3,$4)', [nyId(), userId, rolle, tildeltAv]);
		}
	});
}

/**
 * Kontrollerer at brukeren tilhører virksomheten i konteksten. Kalles før
 * endringer som tar en bruker-id utenfra.
 */
async function krevSammeVirksomhet(userId: string): Promise<void> {
	const bruker = await hentBruker(userId);
	if (!bruker) throw new Error('Brukeren finnes ikke i denne virksomheten');
}

export async function settStatus(userId: string, status: 'aktiv' | 'sperret' | 'avsluttet'): Promise<void> {
	await krevSammeVirksomhet(userId);
	await exec('UPDATE user_account SET status = $2, oppdatert = now() WHERE id = $1', [userId, status]);
	if (status !== 'aktiv') {
		await exec('UPDATE user_session SET avsluttet = true WHERE user_id = $1', [userId]);
		await exec("UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = 'bruker deaktivert' WHERE user_id = $1", [userId]);
	}
}

export async function settPassord(userId: string, passord: string, maByttes = false): Promise<void> {
	await krevSammeVirksomhet(userId);
	await exec('UPDATE user_account SET passord_hash = $2, ma_bytte_passord = $3, oppdatert = now() WHERE id = $1', [
		userId, hashPassord(passord), maByttes
	]);
}

export type Innloggingsresultat =
	| { utfall: 'ok'; bruker: Bruker; roller: Rolle[]; amr: string }
	| { utfall: 'krever-mfa'; bruker: Bruker }
	| { utfall: 'feil-passord' }
	| { utfall: 'laast'; til: string }
	| { utfall: 'sperret' }
	| { utfall: 'ukjent-bruker' };

/**
 * Verifiserer brukernavn, passord og engangskode.
 *
 * Normen krever totrinnsverifisering for tilgang til helseopplysninger utenfor
 * virksomhetens eget nett. Vi krever det som standard, og teller feilede forsøk
 * per konto med midlertidig utestengelse.
 */
export async function loggInn(brukernavn: string, passord: string, totp?: string): Promise<Innloggingsresultat> {
	const rad = await en<Bruker & { passord_hash: string | null; totp_secret_enc: string | null }>(
		`SELECT ${BRUKERFELT}, passord_hash, totp_secret_enc FROM user_account
		 WHERE lower(brukernavn) = lower($1) AND tenant_id IS NOT DISTINCT FROM $2`,
		[brukernavn, krevTenant().id]
	);
	if (!rad || !rad.passord_hash) {
		// Bruk samme arbeidsmengde som ved gyldig bruker, for å ikke avsløre
		// om brukernavnet finnes.
		verifiserPassord(passord, hashPassord('dummy'));
		return { utfall: 'ukjent-bruker' };
	}
	if (rad.status !== 'aktiv') return { utfall: 'sperret' };
	if (rad.laast_til && new Date(rad.laast_til).getTime() > Date.now()) {
		return { utfall: 'laast', til: rad.laast_til };
	}

	if (!verifiserPassord(passord, rad.passord_hash)) {
		const forsok = rad.feilede_forsok + 1;
		const laas = forsok >= config.security.maxFailedLogins;
		await exec(
			`UPDATE user_account SET feilede_forsok = $2, laast_til = CASE WHEN $3 THEN now() + ($4 || ' seconds')::interval ELSE laast_til END
			 WHERE id = $1`,
			[rad.id, laas ? 0 : forsok, laas, String(config.security.lockoutSeconds)]
		);
		return { utfall: 'feil-passord' };
	}

	if (rad.mfa_aktivert && rad.totp_secret_enc) {
		if (!totp) return { utfall: 'krever-mfa', bruker: rad };
		if (!verifiserTotp(dekrypter(rad.totp_secret_enc), totp)) return { utfall: 'feil-passord' };
	} else if (config.security.requireMfa) {
		return { utfall: 'krever-mfa', bruker: rad };
	}

	await exec('UPDATE user_account SET feilede_forsok = 0, laast_til = NULL, siste_innlogging = now() WHERE id = $1', [rad.id]);
	const roller = await rollerFor(rad.id);
	return { utfall: 'ok', bruker: rad, roller, amr: rad.mfa_aktivert ? 'pwd+otp' : 'pwd' };
}

export async function aktiverMfa(userId: string, hemmelighet: string, kode: string): Promise<boolean> {
	await krevSammeVirksomhet(userId);
	if (!verifiserTotp(hemmelighet, kode)) return false;
	await exec('UPDATE user_account SET totp_secret_enc = $2, mfa_aktivert = true, oppdatert = now() WHERE id = $1', [
		userId, krypter(hemmelighet)
	]);
	return true;
}

export async function harMfa(userId: string): Promise<boolean> {
	const rad = await en<{ mfa_aktivert: boolean }>(
		'SELECT mfa_aktivert FROM user_account WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2',
		[userId, krevTenant().id]
	);
	return rad?.mfa_aktivert ?? false;
}

/** Verifiserer engangskode på nytt, f.eks. før nødrettstilgang. */
export async function bekreftTotp(userId: string, kode: string): Promise<boolean> {
	const rad = await en<{ totp_secret_enc: string | null }>(
		'SELECT totp_secret_enc FROM user_account WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2',
		[userId, krevTenant().id]
	);
	if (!rad?.totp_secret_enc) return false;
	return verifiserTotp(dekrypter(rad.totp_secret_enc), kode);
}

export function scopesForBruker(roller: Rolle[]): Set<string> {
	return scopesForRoller(roller);
}

export function rettigheterForBruker(roller: Rolle[]): Set<Rettighet> {
	return rettigheterForRoller(roller);
}
