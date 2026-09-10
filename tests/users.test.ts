import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { one, exec, query } from '../src/lib/server/db/index';
import { time } from '../src/lib/server/tenant/context';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase } from './fixtures/db';
import {
	activateMfa, confirmTotp, getUser, getUserAtUsername, listUsers,
	logIn, createUser, rolesFor, setPassword, setRoles, setStatus
} from '../src/lib/server/auth/users';
import { endAllSessions, endSession, elevateSession, getSession, createSession } from '../src/lib/server/auth/session';
import { newTotpSecret, totpCode } from '../src/lib/server/auth/totp';
import { rateLimit } from '../src/lib/server/http';
import { config } from '../src/lib/server/config';
import { permissionsForRoles, ROLE_DEFINISJONER, ROLES, scopesForRoles, canEmergencyAccess, canSeeAllPatients } from '../src/lib/server/authz/roles';
import { parseScope } from '../src/lib/server/authz/scopes';
import type { Cookies } from '@sveltejs/kit';

const describeIf = hasTestDatabase() ? describe : describe.skip;

/** A simple cookie store covering the part of Cookies we use. */
function layerCookies(): Cookies & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: (name: string) => store.get(name),
		getAll: () => [...store].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => { store.set(name, value); },
		delete: (name: string) => { store.delete(name); },
		serialize: () => ''
	} as unknown as Cookies & { store: Map<string, string> };
}

describe('rollemodell', () => {
	it('har definisjon for hver rolle', () => {
		for (const r of ROLES) expect(ROLE_DEFINISJONER[r]?.name, r).toBeTruthy();
	});

	it('har bare gyldige scope i rolledefinisjonene', () => {
		for (const r of ROLES) {
			for (const s of ROLE_DEFINISJONER[r].scopes) {
				expect(parseScope(s), `${r}: ${s}`).not.toBeNull();
			}
		}
	});

	it('gir helsesekretær administrative rettigheter, men ikke skriving i journal', () => {
		const rett = permissionsForRoles(['helsesekretaer']);
		expect(rett.has('time:administrer')).toBe(true);
		expect(rett.has('journal:skriv')).toBe(false);
		expect(rett.has('resept:forskriv')).toBe(false);
	});

	it('gir systemansvarlig ingen klinisk lesetilgang', () => {
		const rett = permissionsForRoles(['systemansvarlig']);
		expect(rett.has('journal:les')).toBe(false);
		expect(rett.has('admin:brukere')).toBe(true);
		expect([...scopesForRoles(['systemansvarlig'])].some((s) => s.includes('Observation'))).toBe(false);
	});

	it('lar bare kliniske roller bruke nødrett', () => {
		expect(canEmergencyAccess(['lege'])).toBe(true);
		expect(canEmergencyAccess(['sykepleier'])).toBe(true);
		expect(canEmergencyAccess(['helsesekretaer'])).toBe(false);
		expect(canEmergencyAccess(['systemansvarlig'])).toBe(false);
	});

	it('gir bare personvernombudet innsyn på tvers av alle pasienter', () => {
		expect(canSeeAllPatients(['personvernombud'])).toBe(true);
		expect(canSeeAllPatients(['lege'])).toBe(false);
	});

	it('gir pasientrollen bare patient/-scope og ingen skriverettigheter', () => {
		expect([...scopesForRoles(['pasient'])].every((s) => s.startsWith('patient/'))).toBe(true);
		expect(permissionsForRoles(['pasient']).has('journal:skriv')).toBe(false);
	});
});

describeIf('brukere, pålogging og sesjoner', () => {
	let db: TestDatabase;
	beforeAll(async () => { db = await createTestDatabase('brukere'); });
	afterAll(async () => { await db.riv(); });
	beforeEach(async () => { await emptyTables(); });

	describe('brukeradministrasjon', () => {
		it('oppretter bruker med roller', async () => {
			const user = await createUser({ username: 'lege', name: 'Dr. Lege', password: 'Testpassord1!', roles: ['lege'] });
			expect(await rolesFor(user.id)).toEqual(['lege']);
			expect((await getUserAtUsername('LEGE'))?.id).toBe(user.id);
		});

		it('erstatter roller uten å miste historikken', async () => {
			const user = await createUser({ username: 'x', name: 'X', password: 'Testpassord1!', roles: ['sykepleier'] });
			await setRoles(user.id, ['lege'], 'admin-1');
			expect(await rolesFor(user.id)).toEqual(['lege']);
			expect(await query('SELECT 1 FROM role_assignment WHERE user_id = $1', [user.id])).toHaveLength(2);
		});

		it('lister brukere med rollene sine', async () => {
			await createUser({ username: 'a', name: 'A', roles: ['lege'] });
			await createUser({ username: 'b', name: 'B', roles: ['sykepleier', 'jordmor'] });
			const list = await listUsers();
			expect(list.find((b) => b.username === 'b')?.roles.sort()).toEqual(['jordmor', 'sykepleier']);
		});

		it('avslutter sesjoner og trekker tilbake tokens når brukeren deaktiveres', async () => {
			const user = await createUser({ username: 'slutt', name: 'Slutter', password: 'Testpassord1!', roles: ['lege'] });
			const cookies = layerCookies();
			await createSession(user.id, 'pwd', '127.0.0.1', 'test', cookies);
			await setStatus(user.id, 'avsluttet');
			expect(await getSession(cookies)).toBeNull();
			expect((await getUser(user.id))?.status).toBe('avsluttet');
		});
	});

	describe('pålogging', () => {
		const layerLoggedIn = async () => {
			const user = await createUser({ username: 'lege', name: 'Dr. Lege', password: 'Testpassord1!', roles: ['lege'] });
			return user;
		};

		it('sender en konto uten autentiseringsapp til oppsett, ikke til kodefeltet', async () => {
			// Riktig passord, men ingen hemmelighet å regne en kode fra. Å be om en
			// kode her er en blindvei: kontoen kan da aldri brukes. Før dette var
			// utfallet det samme som «skriv inn koden», og enhver bruker opprettet
			// fra brukeradministrasjonen var utestengt for godt.
			await layerLoggedIn();
			const result = await logIn('lege', 'Testpassord1!');
			expect(result.outcome).toBe('krever-mfa-oppsett');
		});

		it('krever engangskode når kontoen har autentiseringsapp', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			expect(await activateMfa(user.id, secret, totpCode(secret))).toBe(true);
			expect((await logIn('lege', 'Testpassord1!')).outcome).toBe('krever-mfa');
		});

		it('logger inn med riktig passord og engangskode', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			expect(await activateMfa(user.id, secret, totpCode(secret))).toBe(true);

			const result = await logIn('lege', 'Testpassord1!', totpCode(secret));
			expect(result.outcome).toBe('ok');
			if (result.outcome === 'ok') {
				expect(result.roles).toEqual(['lege']);
				expect(result.amr).toBe('pwd+otp');
			}
		});

		it('avviser feil engangskode', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			await activateMfa(user.id, secret, totpCode(secret));
			expect((await logIn('lege', 'Testpassord1!', '000000')).outcome).toBe('feil-passord');
		});

		/**
		 * If only wrong passwords are counted, whoever already has the password is
		 * free to guess the six-digit one-time code for as long as they like, and
		 * two-factor is merely a delaying step.
		 */
		it('låser kontoen etter for mange feil engangskoder', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			await activateMfa(user.id, secret, totpCode(secret));
			for (let i = 0; i < config.security.maxFailedLogins; i++) {
				expect((await logIn('lege', 'Testpassord1!', '000000')).outcome).toBe('feil-passord');
			}
			expect((await logIn('lege', 'Testpassord1!', totpCode(secret))).outcome).toBe('laast');
		});

		it('svarer likt for ukjent bruker og feil passord', async () => {
			await layerLoggedIn();
			expect((await logIn('finnesikke', 'hva som helst')).outcome).toBe('ukjent-bruker');
			expect((await logIn('lege', 'feil')).outcome).toBe('feil-passord');
		});

		it('låser kontoen etter for mange feilforsøk', async () => {
			await layerLoggedIn();
			for (let i = 0; i < config.security.maxFailedLogins; i++) {
				await logIn('lege', 'feil');
			}
			expect((await logIn('lege', 'Testpassord1!')).outcome).toBe('laast');
		});

		it('nekter sperret konto', async () => {
			const user = await layerLoggedIn();
			await setStatus(user.id, 'sperret');
			expect((await logIn('lege', 'Testpassord1!')).outcome).toBe('sperret');
		});

		it('nullstiller feilteller ved vellykket pålogging', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			await activateMfa(user.id, secret, totpCode(secret));
			await logIn('lege', 'feil');
			await logIn('lege', 'Testpassord1!', totpCode(secret));
			expect((await getUser(user.id))?.failed_attempts).toBe(0);
		});

		it('lar passord byttes', async () => {
			const user = await layerLoggedIn();
			await setPassword(user.id, 'NyttPassord2?');
			expect((await logIn('lege', 'NyttPassord2?')).outcome).toBe('krever-mfa-oppsett');
			expect((await logIn('lege', 'Testpassord1!')).outcome).toBe('feil-passord');
		});

		it('bekrefter engangskode på nytt ved nødrett', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			await activateMfa(user.id, secret, totpCode(secret));
			expect(await confirmTotp(user.id, totpCode(secret))).toBe(true);
			expect(await confirmTotp(user.id, '111111')).toBe(false);
		});

		it('lagrer TOTP-hemmeligheten kryptert', async () => {
			const user = await layerLoggedIn();
			const secret = newTotpSecret();
			await activateMfa(user.id, secret, totpCode(secret));
			const row = await one<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM user_account WHERE id = $1', [user.id]);
			expect(row?.totp_secret_enc).not.toContain(secret);
			expect(row?.totp_secret_enc.startsWith('v1.')).toBe(true);
		});
	});

	describe('sesjoner', () => {
		it('oppretter, gjenfinner og avslutter sesjon', async () => {
			const user = await createUser({ username: 's', name: 'S', roles: ['lege'] });
			const cookies = layerCookies();
			await createSession(user.id, 'pwd+otp', '192.0.2.1', 'testklient', cookies);

			const session = await getSession(cookies);
			expect(session?.user_id).toBe(user.id);
			expect(session?.amr).toBe('pwd+otp');

			await endSession(cookies);
			expect(await getSession(cookies)).toBeNull();
		});

		it('lagrer bare hashen av sesjonstokenet', async () => {
			const user = await createUser({ username: 's2', name: 'S2', roles: ['lege'] });
			const cookies = layerCookies();
			await createSession(user.id, 'pwd', '192.0.2.1', null, cookies);
			const cookie = cookies.store.get(config.session.cookieName) as string;
			const token = cookie.slice(cookie.indexOf('.') + 1);
			const row = await one<{ token_hash: string }>('SELECT token_hash FROM user_session');
			expect(row?.token_hash).not.toBe(token);
		});

		it('avslutter sesjonen ved feil token på gyldig sesjons-id', async () => {
			const user = await createUser({ username: 's3', name: 'S3', roles: ['lege'] });
			const cookies = layerCookies();
			await createSession(user.id, 'pwd', '192.0.2.1', null, cookies);
			const id = (cookies.store.get(config.session.cookieName) as string).split('.')[0];
			cookies.store.set(config.session.cookieName, `${id}.stjaalet-token`);

			expect(await getSession(cookies)).toBeNull();
			expect((await one<{ ended: boolean }>('SELECT ended FROM user_session'))?.ended).toBe(true);
		});

		it('avviser sesjon som har stått ubrukt for lenge', async () => {
			const user = await createUser({ username: 's4', name: 'S4', roles: ['lege'] });
			const cookies = layerCookies();
			await createSession(user.id, 'pwd', '192.0.2.1', null, cookies);
			await exec("UPDATE user_session SET last_active = now() - interval '2 days'");
			expect(await getSession(cookies)).toBeNull();
		});

		it('avviser utløpt sesjon', async () => {
			const user = await createUser({ username: 's5', name: 'S5', roles: ['lege'] });
			const cookies = layerCookies();
			await createSession(user.id, 'pwd', '192.0.2.1', null, cookies);
			await exec("UPDATE user_session SET expires_at = now() - interval '1 minute'");
			expect(await getSession(cookies)).toBeNull();
		});

		it('markerer reautentisering (step-up)', async () => {
			const user = await createUser({ username: 's6', name: 'S6', roles: ['lege'] });
			const cookies = layerCookies();
			const id = await createSession(user.id, 'pwd', '192.0.2.1', null, cookies);
			await elevateSession(id);
			expect((await getSession(cookies))?.elevated_until).toBeTruthy();
		});

		it('avslutter alle sesjoner for en bruker', async () => {
			const user = await createUser({ username: 's7', name: 'S7', roles: ['lege'] });
			const a = layerCookies();
			const b = layerCookies();
			await createSession(user.id, 'pwd', '1.1.1.1', null, a);
			await createSession(user.id, 'pwd', '2.2.2.2', null, b);
			expect(await endAllSessions(user.id)).toBe(2);
			expect(await getSession(a)).toBeNull();
			expect(await getSession(b)).toBeNull();
		});
	});

	describe('ratebegrensning', () => {
		it('slipper gjennom innenfor grensen og stopper over', async () => {
			for (let i = 0; i < 5; i++) {
				expect((await rateLimit('test:1', 5, 60)).allowed).toBe(true);
			}
			const over = await rateLimit('test:1', 5, 60);
			expect(over.allowed).toBe(false);
			expect(over.remaining).toBe(0);
			expect(over.nullstillesAbout).toBeGreaterThan(0);
		});

		it('holder tellere adskilt per nøkkel', async () => {
			await rateLimit('test:a', 1, 60);
			expect((await rateLimit('test:b', 1, 60)).allowed).toBe(true);
		});

		it('nullstiller når vinduet skifter', async () => {
			await rateLimit('test:c', 1, 60);
			expect((await rateLimit('test:c', 1, 60)).allowed).toBe(false);
			// The organisation is part of the key, so the practices do not share a quota.
			await exec('UPDATE rate_limit SET window_start = window_start - 600 WHERE bucket = $1', [`${time()}:test:c`]);
			expect((await rateLimit('test:c', 1, 60)).allowed).toBe(true);
		});
	});
});
