import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { en, exec, query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase } from './fixtures/db';
import {
	aktiverMfa, bekreftTotp, hentBruker, hentBrukerVedBrukernavn, listBrukere,
	loggInn, opprettBruker, rollerFor, settPassord, settRoller, settStatus
} from '../src/lib/server/auth/brukere';
import { avsluttAlleSesjoner, avsluttSesjon, eleverSesjon, hentSesjon, opprettSesjon } from '../src/lib/server/auth/session';
import { nyTotpHemmelighet, totpKode } from '../src/lib/server/auth/totp';
import { rateLimit } from '../src/lib/server/http';
import { config } from '../src/lib/server/config';
import { rettigheterForRoller, ROLLE_DEFINISJONER, ROLLER, scopesForRoller, kanNodrett, kanSeAllePasienter } from '../src/lib/server/authz/roles';
import { parseScope } from '../src/lib/server/authz/scopes';
import type { Cookies } from '@sveltejs/kit';

const beskriv = harTestdatabase() ? describe : describe.skip;

/** Enkel cookie-butikk som oppfyller den delen av Cookies vi bruker. */
function lagCookies(): Cookies & { lager: Map<string, string> } {
	const lager = new Map<string, string>();
	return {
		lager,
		get: (navn: string) => lager.get(navn),
		getAll: () => [...lager].map(([name, value]) => ({ name, value })),
		set: (navn: string, verdi: string) => { lager.set(navn, verdi); },
		delete: (navn: string) => { lager.delete(navn); },
		serialize: () => ''
	} as unknown as Cookies & { lager: Map<string, string> };
}

describe('rollemodell', () => {
	it('har definisjon for hver rolle', () => {
		for (const r of ROLLER) expect(ROLLE_DEFINISJONER[r]?.navn, r).toBeTruthy();
	});

	it('har bare gyldige scope i rolledefinisjonene', () => {
		for (const r of ROLLER) {
			for (const s of ROLLE_DEFINISJONER[r].scopes) {
				expect(parseScope(s), `${r}: ${s}`).not.toBeNull();
			}
		}
	});

	it('gir helsesekretær administrative rettigheter, men ikke skriving i journal', () => {
		const rett = rettigheterForRoller(['helsesekretaer']);
		expect(rett.has('time:administrer')).toBe(true);
		expect(rett.has('journal:skriv')).toBe(false);
		expect(rett.has('resept:forskriv')).toBe(false);
	});

	it('gir systemansvarlig ingen klinisk lesetilgang', () => {
		const rett = rettigheterForRoller(['systemansvarlig']);
		expect(rett.has('journal:les')).toBe(false);
		expect(rett.has('admin:brukere')).toBe(true);
		expect([...scopesForRoller(['systemansvarlig'])].some((s) => s.includes('Observation'))).toBe(false);
	});

	it('lar bare kliniske roller bruke nødrett', () => {
		expect(kanNodrett(['lege'])).toBe(true);
		expect(kanNodrett(['sykepleier'])).toBe(true);
		expect(kanNodrett(['helsesekretaer'])).toBe(false);
		expect(kanNodrett(['systemansvarlig'])).toBe(false);
	});

	it('gir bare personvernombudet innsyn på tvers av alle pasienter', () => {
		expect(kanSeAllePasienter(['personvernombud'])).toBe(true);
		expect(kanSeAllePasienter(['lege'])).toBe(false);
	});

	it('gir pasientrollen bare patient/-scope og ingen skriverettigheter', () => {
		expect([...scopesForRoller(['pasient'])].every((s) => s.startsWith('patient/'))).toBe(true);
		expect(rettigheterForRoller(['pasient']).has('journal:skriv')).toBe(false);
	});
});

beskriv('brukere, pålogging og sesjoner', () => {
	let db: Testdatabase;
	beforeAll(async () => { db = await opprettTestdatabase('brukere'); });
	afterAll(async () => { await db.riv(); });
	beforeEach(async () => { await tomTabeller(); });

	describe('brukeradministrasjon', () => {
		it('oppretter bruker med roller', async () => {
			const bruker = await opprettBruker({ brukernavn: 'lege', navn: 'Dr. Lege', passord: 'Testpassord1!', roller: ['lege'] });
			expect(await rollerFor(bruker.id)).toEqual(['lege']);
			expect((await hentBrukerVedBrukernavn('LEGE'))?.id).toBe(bruker.id);
		});

		it('erstatter roller uten å miste historikken', async () => {
			const bruker = await opprettBruker({ brukernavn: 'x', navn: 'X', passord: 'Testpassord1!', roller: ['sykepleier'] });
			await settRoller(bruker.id, ['lege'], 'admin-1');
			expect(await rollerFor(bruker.id)).toEqual(['lege']);
			expect(await query('SELECT 1 FROM role_assignment WHERE user_id = $1', [bruker.id])).toHaveLength(2);
		});

		it('lister brukere med rollene sine', async () => {
			await opprettBruker({ brukernavn: 'a', navn: 'A', roller: ['lege'] });
			await opprettBruker({ brukernavn: 'b', navn: 'B', roller: ['sykepleier', 'jordmor'] });
			const liste = await listBrukere();
			expect(liste.find((b) => b.brukernavn === 'b')?.roller.sort()).toEqual(['jordmor', 'sykepleier']);
		});

		it('avslutter sesjoner og trekker tilbake tokens når brukeren deaktiveres', async () => {
			const bruker = await opprettBruker({ brukernavn: 'slutt', navn: 'Slutter', passord: 'Testpassord1!', roller: ['lege'] });
			const cookies = lagCookies();
			await opprettSesjon(bruker.id, 'pwd', '127.0.0.1', 'test', cookies);
			await settStatus(bruker.id, 'avsluttet');
			expect(await hentSesjon(cookies)).toBeNull();
			expect((await hentBruker(bruker.id))?.status).toBe('avsluttet');
		});
	});

	describe('pålogging', () => {
		const lagInnlogget = async () => {
			const bruker = await opprettBruker({ brukernavn: 'lege', navn: 'Dr. Lege', passord: 'Testpassord1!', roller: ['lege'] });
			return bruker;
		};

		it('krever totrinnsverifisering når det er slått på', async () => {
			await lagInnlogget();
			const resultat = await loggInn('lege', 'Testpassord1!');
			expect(resultat.utfall).toBe('krever-mfa');
		});

		it('logger inn med riktig passord og engangskode', async () => {
			const bruker = await lagInnlogget();
			const hemmelighet = nyTotpHemmelighet();
			expect(await aktiverMfa(bruker.id, hemmelighet, totpKode(hemmelighet))).toBe(true);

			const resultat = await loggInn('lege', 'Testpassord1!', totpKode(hemmelighet));
			expect(resultat.utfall).toBe('ok');
			if (resultat.utfall === 'ok') {
				expect(resultat.roller).toEqual(['lege']);
				expect(resultat.amr).toBe('pwd+otp');
			}
		});

		it('avviser feil engangskode', async () => {
			const bruker = await lagInnlogget();
			const hemmelighet = nyTotpHemmelighet();
			await aktiverMfa(bruker.id, hemmelighet, totpKode(hemmelighet));
			expect((await loggInn('lege', 'Testpassord1!', '000000')).utfall).toBe('feil-passord');
		});

		it('svarer likt for ukjent bruker og feil passord', async () => {
			await lagInnlogget();
			expect((await loggInn('finnesikke', 'hva som helst')).utfall).toBe('ukjent-bruker');
			expect((await loggInn('lege', 'feil')).utfall).toBe('feil-passord');
		});

		it('låser kontoen etter for mange feilforsøk', async () => {
			await lagInnlogget();
			for (let i = 0; i < config.security.maxFailedLogins; i++) {
				await loggInn('lege', 'feil');
			}
			expect((await loggInn('lege', 'Testpassord1!')).utfall).toBe('laast');
		});

		it('nekter sperret konto', async () => {
			const bruker = await lagInnlogget();
			await settStatus(bruker.id, 'sperret');
			expect((await loggInn('lege', 'Testpassord1!')).utfall).toBe('sperret');
		});

		it('nullstiller feilteller ved vellykket pålogging', async () => {
			const bruker = await lagInnlogget();
			const hemmelighet = nyTotpHemmelighet();
			await aktiverMfa(bruker.id, hemmelighet, totpKode(hemmelighet));
			await loggInn('lege', 'feil');
			await loggInn('lege', 'Testpassord1!', totpKode(hemmelighet));
			expect((await hentBruker(bruker.id))?.feilede_forsok).toBe(0);
		});

		it('lar passord byttes', async () => {
			const bruker = await lagInnlogget();
			await settPassord(bruker.id, 'NyttPassord2?');
			expect((await loggInn('lege', 'NyttPassord2?')).utfall).toBe('krever-mfa');
			expect((await loggInn('lege', 'Testpassord1!')).utfall).toBe('feil-passord');
		});

		it('bekrefter engangskode på nytt ved nødrett', async () => {
			const bruker = await lagInnlogget();
			const hemmelighet = nyTotpHemmelighet();
			await aktiverMfa(bruker.id, hemmelighet, totpKode(hemmelighet));
			expect(await bekreftTotp(bruker.id, totpKode(hemmelighet))).toBe(true);
			expect(await bekreftTotp(bruker.id, '111111')).toBe(false);
		});

		it('lagrer TOTP-hemmeligheten kryptert', async () => {
			const bruker = await lagInnlogget();
			const hemmelighet = nyTotpHemmelighet();
			await aktiverMfa(bruker.id, hemmelighet, totpKode(hemmelighet));
			const rad = await en<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM user_account WHERE id = $1', [bruker.id]);
			expect(rad?.totp_secret_enc).not.toContain(hemmelighet);
			expect(rad?.totp_secret_enc.startsWith('v1.')).toBe(true);
		});
	});

	describe('sesjoner', () => {
		it('oppretter, gjenfinner og avslutter sesjon', async () => {
			const bruker = await opprettBruker({ brukernavn: 's', navn: 'S', roller: ['lege'] });
			const cookies = lagCookies();
			await opprettSesjon(bruker.id, 'pwd+otp', '192.0.2.1', 'testklient', cookies);

			const sesjon = await hentSesjon(cookies);
			expect(sesjon?.user_id).toBe(bruker.id);
			expect(sesjon?.amr).toBe('pwd+otp');

			await avsluttSesjon(cookies);
			expect(await hentSesjon(cookies)).toBeNull();
		});

		it('lagrer bare hashen av sesjonstokenet', async () => {
			const bruker = await opprettBruker({ brukernavn: 's2', navn: 'S2', roller: ['lege'] });
			const cookies = lagCookies();
			await opprettSesjon(bruker.id, 'pwd', '192.0.2.1', null, cookies);
			const cookie = cookies.lager.get(config.session.cookieName) as string;
			const token = cookie.slice(cookie.indexOf('.') + 1);
			const rad = await en<{ token_hash: string }>('SELECT token_hash FROM user_session');
			expect(rad?.token_hash).not.toBe(token);
		});

		it('avslutter sesjonen ved feil token på gyldig sesjons-id', async () => {
			const bruker = await opprettBruker({ brukernavn: 's3', navn: 'S3', roller: ['lege'] });
			const cookies = lagCookies();
			await opprettSesjon(bruker.id, 'pwd', '192.0.2.1', null, cookies);
			const id = (cookies.lager.get(config.session.cookieName) as string).split('.')[0];
			cookies.lager.set(config.session.cookieName, `${id}.stjaalet-token`);

			expect(await hentSesjon(cookies)).toBeNull();
			expect((await en<{ avsluttet: boolean }>('SELECT avsluttet FROM user_session'))?.avsluttet).toBe(true);
		});

		it('avviser sesjon som har stått ubrukt for lenge', async () => {
			const bruker = await opprettBruker({ brukernavn: 's4', navn: 'S4', roller: ['lege'] });
			const cookies = lagCookies();
			await opprettSesjon(bruker.id, 'pwd', '192.0.2.1', null, cookies);
			await exec("UPDATE user_session SET sist_aktiv = now() - interval '2 days'");
			expect(await hentSesjon(cookies)).toBeNull();
		});

		it('avviser utløpt sesjon', async () => {
			const bruker = await opprettBruker({ brukernavn: 's5', navn: 'S5', roller: ['lege'] });
			const cookies = lagCookies();
			await opprettSesjon(bruker.id, 'pwd', '192.0.2.1', null, cookies);
			await exec("UPDATE user_session SET utloper = now() - interval '1 minute'");
			expect(await hentSesjon(cookies)).toBeNull();
		});

		it('markerer reautentisering (step-up)', async () => {
			const bruker = await opprettBruker({ brukernavn: 's6', navn: 'S6', roller: ['lege'] });
			const cookies = lagCookies();
			const id = await opprettSesjon(bruker.id, 'pwd', '192.0.2.1', null, cookies);
			await eleverSesjon(id);
			expect((await hentSesjon(cookies))?.elevert_til).toBeTruthy();
		});

		it('avslutter alle sesjoner for en bruker', async () => {
			const bruker = await opprettBruker({ brukernavn: 's7', navn: 'S7', roller: ['lege'] });
			const a = lagCookies();
			const b = lagCookies();
			await opprettSesjon(bruker.id, 'pwd', '1.1.1.1', null, a);
			await opprettSesjon(bruker.id, 'pwd', '2.2.2.2', null, b);
			expect(await avsluttAlleSesjoner(bruker.id)).toBe(2);
			expect(await hentSesjon(a)).toBeNull();
			expect(await hentSesjon(b)).toBeNull();
		});
	});

	describe('ratebegrensning', () => {
		it('slipper gjennom innenfor grensen og stopper over', async () => {
			for (let i = 0; i < 5; i++) {
				expect((await rateLimit('test:1', 5, 60)).tillatt).toBe(true);
			}
			const over = await rateLimit('test:1', 5, 60);
			expect(over.tillatt).toBe(false);
			expect(over.gjenstaende).toBe(0);
			expect(over.nullstillesOm).toBeGreaterThan(0);
		});

		it('holder tellere adskilt per nøkkel', async () => {
			await rateLimit('test:a', 1, 60);
			expect((await rateLimit('test:b', 1, 60)).tillatt).toBe(true);
		});

		it('nullstiller når vinduet skifter', async () => {
			await rateLimit('test:c', 1, 60);
			expect((await rateLimit('test:c', 1, 60)).tillatt).toBe(false);
			await exec('UPDATE rate_limit SET vindu_start = vindu_start - 600 WHERE bucket = $1', ['test:c']);
			expect((await rateLimit('test:c', 1, 60)).tillatt).toBe(true);
		});
	});
});
