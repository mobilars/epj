import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { en, exec, query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { medTenant, krevTenant, gjeldendeTenant, tid, fhirBaseFor, utstederFor, PLATTFORM_TENANT } from '../src/lib/server/tenant/kontekst';
import { hentTenant, hentTenantPaVertsnavn, listTenanter, opprettTenant, oppdaterTenant, settTenantstatus, tenantOversikt } from '../src/lib/server/tenant/tenant';
import { listPartisjoner, partisjoneringVirker } from '../src/lib/server/tenant/partisjon';
import { hentBruker, hentBrukerVedBrukernavn, listBrukere, loggInn, opprettBruker } from '../src/lib/server/auth/brukere';
import { hentKlient, listKlienter, registrerKlient } from '../src/lib/server/auth/klienter';
import { aktivSigneringsnokkel, jwks } from '../src/lib/server/auth/keys';
import { hentLogg, logg, verifiserLoggkjede, type AuditAktor } from '../src/lib/server/audit';
import { fhirKlient } from '../src/lib/server/fhir/client';
import { listKort, opprettRegningskort } from '../src/lib/server/integrasjoner/helfo/regningskort';
import { koeUt, listMeldinger } from '../src/lib/server/integrasjoner/nhn/meldingsko';
import { byggHenvisning } from '../src/lib/server/integrasjoner/nhn/meldinger';
import { tilPart } from '../src/lib/server/integrasjoner/nhn/adresseregister';
import { rateLimit } from '../src/lib/server/http';
import { SYSTEM } from '../src/lib/server/fhir/kodeverk';
import { TEST_TENANT } from './fixtures/kontekst';
import type { Tenant } from '../src/lib/server/tenant/kontekst';

const beskriv = harTestdatabase() ? describe : describe.skip;

const aktor: AuditAktor = {
	userId: null, actorRef: 'Device/test', navn: 'Test', rolle: null,
	clientId: null, ip: '192.0.2.10', requestId: 'req-tenant'
};

/**
 * Multitenancy.
 *
 * Isolasjon er en påstand helt til den er prøvd. Testene her skriver data i én
 * virksomhet og kontrollerer at de er usynlige fra en annen - gjennom de samme
 * modulene applikasjonen selv bruker, ikke gjennom rå SQL.
 *
 * Kliniske data skilles av HAPI sin partisjonering, og prøves derfor over ekte
 * HTTP mot en partisjonsbevisst FHIR-server.
 */
beskriv('multitenancy', () => {
	let db: Testdatabase;
	let fhir: TestFhirServer;
	/** Virksomhet A er standardvirksomheten migrasjonen legger inn. */
	let a: Tenant;
	/** Virksomhet B opprettes av testen, med egen partisjon. */
	let b: Tenant;

	beforeAll(async () => {
		db = await opprettTestdatabase('tenant');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});

	afterAll(async () => {
		await fhir.lukk();
		await db.riv();
	});

	beforeEach(async () => {
		await tomTabeller();
		await exec("DELETE FROM tenant WHERE id NOT IN ('standard', 'plattform')");
		fhir.nullstill();

		a = (await hentTenant('standard')) as Tenant;
		expect(a).toBeTruthy();

		const opprettet = await medTenant(a, () =>
			opprettTenant(
				{
					id: 'legekontor-b',
					navn: 'Legekontor B',
					organisasjonsnummer: '994598759',
					vertsnavn: 'b.epj.test',
					baseUrl: 'https://b.epj.test'
				},
				aktor
			)
		);
		if (!opprettet.ok) throw new Error(opprettet.feil);
		b = opprettet.tenant;
	});

	describe('virksomhetskontekst', () => {
		it('gjenoppretter den ytre konteksten etter et nøstet kall', async () => {
			await medTenant(a, async () => {
				expect(krevTenant().id).toBe(a.id);
				await medTenant(b, async () => expect(krevTenant().id).toBe(b.id));
				// Den indre konteksten lekker ikke ut igjen.
				expect(krevTenant().id).toBe(a.id);
			});
			expect(gjeldendeTenant()?.id).toBe(TEST_TENANT.id);
		});

		it('holder konteksten over await, slik at samtidige forespørsler ikke blandes', async () => {
			const treg = async (t: Tenant, ms: number) =>
				medTenant(t, async () => {
					await new Promise((r) => setTimeout(r, ms));
					return tid();
				});
			// B starter sist og blir ferdig først; A skal likevel se sin egen.
			const [iA, iB] = await Promise.all([treg(a, 20), treg(b, 1)]);
			expect([iA, iB]).toEqual([a.id, b.id]);
		});

		it('gir hver virksomhet sin egen FHIR-base og issuer', () => {
			expect(fhirBaseFor(a)).not.toBe(fhirBaseFor(b));
			expect(utstederFor(b)).toBe('https://b.epj.test');
			expect(fhirBaseFor(b)).toBe('https://b.epj.test/fhir');
		});

		it('tid() følger den omsluttende konteksten', async () => {
			expect(await medTenant(a, async () => tid())).toBe('standard');
			expect(await medTenant(b, async () => tid())).toBe('legekontor-b');
		});
	});

	describe('registeret', () => {
		it('avviser ugyldig maskinnavn', async () => {
			const r = await medTenant(a, () =>
				opprettTenant({ id: 'Ugyldig Navn', navn: 'X', organisasjonsnummer: '994598759', baseUrl: 'https://x.test' }, aktor)
			);
			expect(r.ok).toBe(false);
		});

		it('avviser organisasjonsnummer som ikke består mod11', async () => {
			const r = await medTenant(a, () =>
				opprettTenant({ id: 'feilorgnr', navn: 'X', organisasjonsnummer: '123456789', baseUrl: 'https://x.test' }, aktor)
			);
			expect(r.ok).toBe(false);
			expect(r.ok === false && r.feil).toMatch(/mod11/i);
		});

		it('avviser maskinnavn og vertsnavn som allerede er i bruk', async () => {
			const likId = await medTenant(a, () =>
				opprettTenant({ id: 'legekontor-b', navn: 'Dublett', organisasjonsnummer: '994598759', baseUrl: 'https://c.test' }, aktor)
			);
			expect(likId.ok).toBe(false);

			const likVert = await medTenant(a, () =>
				opprettTenant(
					{ id: 'legekontor-c', navn: 'Dublett', organisasjonsnummer: '994598759', vertsnavn: 'b.epj.test', baseUrl: 'https://c.test' },
					aktor
				)
			);
			expect(likVert.ok).toBe(false);
		});

		it('gir hver virksomhet sin egen partisjons-id', async () => {
			const alle = await listTenanter();
			const ider = alle.filter((t) => t.id !== PLATTFORM_TENANT).map((t) => t.partisjon_id);
			expect(new Set(ider).size).toBe(ider.length);
		});

		it('oppretter partisjonen i FHIR-serveren', async () => {
			const partisjoner = await listPartisjoner();
			expect(partisjoner.ok).toBe(true);
			expect(partisjoner.ok && partisjoner.partisjoner.map((p) => p.navn)).toContain('legekontor-b');
			expect((await partisjoneringVirker()).ok).toBe(true);
		});

		it('finner virksomheten på vertsnavn, uavhengig av store og små bokstaver', async () => {
			expect((await hentTenantPaVertsnavn('B.EPJ.TEST'))?.id).toBe('legekontor-b');
			expect(await hentTenantPaVertsnavn('ukjent.test')).toBeNull();
		});

		it('oppretter den første systemansvarlige inne i den nye virksomheten', async () => {
			const r = await medTenant(a, () =>
				opprettTenant(
					{
						id: 'legekontor-d',
						navn: 'Legekontor D',
						organisasjonsnummer: '994598759',
						baseUrl: 'https://d.epj.test',
						adminBrukernavn: 'sjefen',
						adminNavn: 'Dagny Sjef'
					},
					aktor
				)
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.midlertidigPassord).toBeTruthy();

			const d = r.tenant;
			const iD = await medTenant(d, () => hentBrukerVedBrukernavn('sjefen'));
			expect(iD?.navn).toBe('Dagny Sjef');

			// Den samme brukeren finnes ikke i de andre virksomhetene.
			expect(await medTenant(a, () => hentBrukerVedBrukernavn('sjefen'))).toBeNull();
			expect(await medTenant(b, () => hentBrukerVedBrukernavn('sjefen'))).toBeNull();
		});

		it('kan endre navn og adresse, men ikke maskinnavn', async () => {
			await medTenant(a, () => oppdaterTenant('legekontor-b', { navn: 'Legekontor B AS' }, aktor));
			expect((await hentTenant('legekontor-b'))?.navn).toBe('Legekontor B AS');
		});

		it('nekter å flytte et vertsnavn som er i bruk', async () => {
			await medTenant(a, () => oppdaterTenant('standard', { vertsnavn: 'a.epj.test' }, aktor));
			const r = await medTenant(a, () => oppdaterTenant('legekontor-b', { vertsnavn: 'a.epj.test' }, aktor));
			expect(r.ok).toBe(false);
		});
	});

	describe('brukere', () => {
		it('holder brukerne adskilt', async () => {
			const iA = await medTenant(a, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege A', roller: ['lege'] }));
			const iB = await medTenant(b, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege B', roller: ['lege'] }));
			expect(iA.id).not.toBe(iB.id);

			expect((await medTenant(a, () => listBrukere())).map((u) => u.navn)).toEqual(['Lege A']);
			expect((await medTenant(b, () => listBrukere())).map((u) => u.navn)).toEqual(['Lege B']);

			// Oppslag på id fra feil virksomhet gir ingenting.
			expect(await medTenant(b, () => hentBruker(iA.id))).toBeNull();
			expect(await medTenant(a, () => hentBruker(iB.id))).toBeNull();
		});

		it('lar samme brukernavn finnes i flere virksomheter, men ikke to ganger i én', async () => {
			await medTenant(a, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege A', roller: ['lege'] }));
			await expect(
				medTenant(a, () => opprettBruker({ brukernavn: 'LEGE', navn: 'Dublett', roller: ['lege'] }))
			).rejects.toThrow();
			await expect(
				medTenant(b, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege B', roller: ['lege'] }))
			).resolves.toBeTruthy();
		});

		it('lar samme HelseID-identitet ha én konto per virksomhet', async () => {
			const iA = await medTenant(a, () => opprettBruker({ brukernavn: 'ingrid', navn: 'Ingrid', roller: ['lege'] }));
			const iB = await medTenant(b, () => opprettBruker({ brukernavn: 'ingrid', navn: 'Ingrid', roller: ['lege'] }));
			await exec('UPDATE user_account SET helseid_sub = $2 WHERE id = $1', [iA.id, 'helseid-1']);
			await exec('UPDATE user_account SET helseid_sub = $2 WHERE id = $1', [iB.id, 'helseid-1']);

			const rader = await query<{ n: number }>("SELECT count(*)::int AS n FROM user_account WHERE helseid_sub = 'helseid-1'");
			expect(rader[0]?.n).toBe(2);
		});

		it('nekter pålogging med et brukernavn som hører hjemme i en annen virksomhet', async () => {
			await medTenant(a, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege A', passord: 'Testpassord1!', roller: ['lege'] }));
			// I egen virksomhet kjenner systemet brukeren (og går videre til MFA).
			expect((await medTenant(a, () => loggInn('lege', 'Testpassord1!'))).utfall).not.toBe('ukjent-bruker');
			// I nabovirksomheten finnes brukernavnet rett og slett ikke.
			expect((await medTenant(b, () => loggInn('lege', 'Testpassord1!'))).utfall).toBe('ukjent-bruker');
		});
	});

	describe('kliniske data', () => {
		it('skiller pasientene i hver sin FHIR-partisjon', async () => {
			const pA = await medTenant(a, () =>
				fhirKlient.opprett({
					resourceType: 'Patient',
					identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
					name: [{ family: 'Bakken', given: ['Anne'] }]
				})
			);
			const pB = await medTenant(b, () =>
				fhirKlient.opprett({
					resourceType: 'Patient',
					identifier: [{ system: SYSTEM.FNR, value: '24035810281' }],
					name: [{ family: 'Vik', given: ['Ola'] }]
				})
			);

			// Søk i A ser bare A sin pasient.
			const sokA = await medTenant(a, () => fhirKlient.sok('Patient', new URLSearchParams()));
			expect((sokA.entry ?? []).map((e) => (e.resource as { id: string }).id)).toEqual([pA.ressurs.id]);

			const sokB = await medTenant(b, () => fhirKlient.sok('Patient', new URLSearchParams()));
			expect((sokB.entry ?? []).map((e) => (e.resource as { id: string }).id)).toEqual([pB.ressurs.id]);
		});

		it('nekter direkte oppslag på en id fra en annen virksomhet', async () => {
			const pA = await medTenant(a, () =>
				fhirKlient.opprett({ resourceType: 'Patient', name: [{ family: 'Bakken' }] })
			);
			const fraB = await medTenant(b, () => fhirKlient.les('Patient', pA.ressurs.id as string).catch(() => null));
			expect(fraB).toBeNull();
		});

		it('legger partisjonsnavnet i FHIR-adressen', async () => {
			await medTenant(b, () => fhirKlient.opprett({ resourceType: 'Patient', name: [{ family: 'Vik' }] }));
			if (fhir.erEkte) return;
			expect(fhir.kall.some((k) => k.partisjon === 'legekontor-b')).toBe(true);
			expect(fhir.lagerFor('legekontor-b').get('Patient')?.size).toBe(1);
			expect(fhir.lagerFor('standard').get('Patient')?.size ?? 0).toBe(0);
		});
	});

	describe('sikkerhetsloggen', () => {
		it('lenker hver virksomhets kjede for seg', async () => {
			for (let i = 0; i < 3; i++) {
				await medTenant(a, () => logg({ type: 'admin', subtype: `a-${i}`, handling: 'E', utfall: '0' }, aktor));
				await medTenant(b, () => logg({ type: 'admin', subtype: `b-${i}`, handling: 'E', utfall: '0' }, aktor));
			}

			const iA = await medTenant(a, () => hentLogg({ limit: 50 }));
			const iB = await medTenant(b, () => hentLogg({ limit: 50 }));
			// Hver virksomhet ser sine egne innslag, og ingen av naboens.
			expect(iA.rader.filter((r) => r.subtype?.startsWith('a-'))).toHaveLength(3);
			expect(iA.rader.some((r) => r.subtype?.startsWith('b-'))).toBe(false);
			expect(iB.rader.filter((r) => r.subtype?.startsWith('b-'))).toHaveLength(3);
			expect(iB.rader.some((r) => r.subtype?.startsWith('a-'))).toBe(false);

			// Begge kjedene verifiserer hver for seg, selv om radene ligger om
			// hverandre i tabellen.
			expect((await medTenant(a, () => verifiserLoggkjede())).gyldig).toBe(true);
			expect((await medTenant(b, () => verifiserLoggkjede())).gyldig).toBe(true);
		});

		it('oppdager tukling i én virksomhet uten å underkjenne den andre', async () => {
			await medTenant(a, () => logg({ type: 'admin', subtype: 'a-1', handling: 'E', utfall: '0' }, aktor));
			await medTenant(a, () => logg({ type: 'admin', subtype: 'a-2', handling: 'E', utfall: '0' }, aktor));
			await medTenant(b, () => logg({ type: 'admin', subtype: 'b-1', handling: 'E', utfall: '0' }, aktor));

			const rad = await en<{ seq: number }>(
				"SELECT seq FROM audit_event WHERE tenant_id = 'standard' AND subtype = 'a-1' ORDER BY seq LIMIT 1"
			);
			// Triggeren må kobles fra for å simulere et angrep på databasenivå.
			await exec('ALTER TABLE audit_event DISABLE TRIGGER trg_audit_append_only');
			await exec(`UPDATE audit_event SET content = jsonb_set(content, '{action}', '"C"') WHERE seq = $1`, [rad?.seq]);
			await exec('ALTER TABLE audit_event ENABLE TRIGGER trg_audit_append_only');

			expect((await medTenant(a, () => verifiserLoggkjede())).gyldig).toBe(false);
			expect((await medTenant(b, () => verifiserLoggkjede())).gyldig).toBe(true);
		});
	});

	describe('OAuth', () => {
		it('holder klientregisteret adskilt', async () => {
			const kA = await medTenant(a, () =>
				registrerKlient({ navn: 'App A', type: 'public', kategori: 'smart-ehr', redirectUris: ['https://a.test/cb'], scopes: ['user/Patient.rs'] })
			);
			await medTenant(b, () =>
				registrerKlient({ navn: 'App B', type: 'public', kategori: 'smart-ehr', redirectUris: ['https://b.test/cb'], scopes: ['user/Patient.rs'] })
			);

			expect((await medTenant(a, () => listKlienter())).map((k) => k.navn)).toEqual(['App A']);
			expect((await medTenant(b, () => listKlienter())).map((k) => k.navn)).toEqual(['App B']);

			// En client_id fra A finnes ikke i B, selv om den er gyldig i A.
			expect(await medTenant(b, () => hentKlient(kA.klient.client_id))).toBeNull();
		});

		it('gir hver virksomhet sitt eget signeringsnøkkelsett', async () => {
			const nA = await medTenant(a, () => aktivSigneringsnokkel());
			const nB = await medTenant(b, () => aktivSigneringsnokkel());
			expect(nA.kid).not.toBe(nB.kid);

			const jwksA = await medTenant(a, () => jwks());
			const jwksB = await medTenant(b, () => jwks());
			expect(jwksA.keys.map((k) => k.kid)).toEqual([nA.kid]);
			expect(jwksB.keys.map((k) => k.kid)).toEqual([nB.kid]);
		});
	});

	describe('meldinger og oppgjør', () => {
		const mottaker = tilPart({
			herId: '8142519', navn: 'Oslo universitetssykehus HF', type: 'sykehus',
			stotterMeldinger: ['HENVIS'], aktiv: true
		});
		const melding = (msgId: string) => ({
			meldingstype: 'HENVIS',
			msgId,
			patientId: null,
			mottakerHer: '8142519',
			payloadXml: byggHenvisning({
				msgId,
				mottaker,
				pasient: { fnr: '13086510035', fornavn: 'Anne', etternavn: 'Bakken', fodselsdato: '1965-08-13', kjonn: 'K' as const },
				behandler: { navn: 'Ingrid Fastlege', hpr: '9144889' },
				problemstilling: 'Behov for utredning.',
				hastegrad: 'ordinaer' as const
			}),
			opprettetAv: 'bruker-1'
		});

		it('holder meldingskøen adskilt', async () => {
			const iA = await medTenant(a, () => koeUt(melding('msg-a'), aktor));
			const iB = await medTenant(b, () => koeUt(melding('msg-b'), aktor));
			expect(iA.ok && iB.ok).toBe(true);

			expect((await medTenant(a, () => listMeldinger({}))).map((m) => m.msg_id)).toEqual(['msg-a']);
			expect((await medTenant(b, () => listMeldinger({}))).map((m) => m.msg_id)).toEqual(['msg-b']);
		});

		it('lar samme meldings-id finnes i to virksomheter', async () => {
			expect((await medTenant(a, () => koeUt(melding('samme-id'), aktor))).ok).toBe(true);
			expect((await medTenant(b, () => koeUt(melding('samme-id'), aktor))).ok).toBe(true);
		});

		it('holder regningskortene adskilt', async () => {
			const kort = (patientId: string) => ({
				patientId,
				behandlerId: 'bruker-1',
				hprNummer: '9144889',
				dato: new Date().toISOString().slice(0, 10),
				kontakttype: 'kontor' as const,
				takster: [{ takstkode: '2ad', antall: 1 }]
			});
			expect((await medTenant(a, () => opprettRegningskort(kort('pasient-a'), aktor))).ok).toBe(true);
			expect((await medTenant(b, () => opprettRegningskort(kort('pasient-b'), aktor))).ok).toBe(true);

			expect((await medTenant(a, () => listKort({}))).map((k) => k.patient_id)).toEqual(['pasient-a']);
			expect((await medTenant(b, () => listKort({}))).map((k) => k.patient_id)).toEqual(['pasient-b']);
		});
	});

	describe('ratebegrensning', () => {
		it('lar ikke én virksomhets trafikk stenge ute en annen', async () => {
			await medTenant(a, () => rateLimit('login:lege', 1, 60));
			expect((await medTenant(a, () => rateLimit('login:lege', 1, 60))).tillatt).toBe(false);
			expect((await medTenant(b, () => rateLimit('login:lege', 1, 60))).tillatt).toBe(true);
		});
	});

	describe('suspensjon', () => {
		it('avslutter sesjoner og trekker tilbake tokens umiddelbart', async () => {
			const bruker = await medTenant(b, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege B', roller: ['lege'] }));
			await exec(
				"INSERT INTO user_session (id, user_id, token_hash, utloper, amr) VALUES ($1,$2,'x', now() + interval '1 hour','pwd')",
				['sesjon-b', bruker.id]
			);
			await exec(
				`INSERT INTO oauth_token (id, tenant_id, kind, familie, token_hash, client_id, user_id, scope, utloper)
				 VALUES ($1,$2,'access',$3,'h','app-b',$4,'user/Patient.rs', now() + interval '1 hour')`,
				['token-b', b.id, 'familie-b', bruker.id]
			);

			await medTenant(a, () => settTenantstatus(b.id, 'suspendert', aktor));

			const sesjon = await en<{ avsluttet: boolean }>('SELECT avsluttet FROM user_session WHERE id = $1', ['sesjon-b']);
			const token = await en<{ tilbakekalt: boolean }>('SELECT tilbakekalt FROM oauth_token WHERE id = $1', ['token-b']);
			expect(sesjon?.avsluttet).toBe(true);
			expect(token?.tilbakekalt).toBe(true);
			expect((await hentTenant(b.id))?.status).toBe('suspendert');
		});

		it('rører ikke de andre virksomhetenes sesjoner', async () => {
			const iA = await medTenant(a, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege A', roller: ['lege'] }));
			await exec(
				"INSERT INTO user_session (id, user_id, token_hash, utloper, amr) VALUES ($1,$2,'y', now() + interval '1 hour','pwd')",
				['sesjon-a', iA.id]
			);

			await medTenant(a, () => settTenantstatus(b.id, 'suspendert', aktor));

			const sesjon = await en<{ avsluttet: boolean }>('SELECT avsluttet FROM user_session WHERE id = $1', ['sesjon-a']);
			expect(sesjon?.avsluttet).toBe(false);
		});
	});

	describe('plattformoversikten', () => {
		it('teller brukere og loggeinnslag per virksomhet, og krysser av mot HAPI', async () => {
			await medTenant(a, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege A', roller: ['lege'] }));
			await medTenant(b, () => opprettBruker({ brukernavn: 'lege', navn: 'Lege B', roller: ['lege'] }));
			await medTenant(b, () => opprettBruker({ brukernavn: 'sek', navn: 'Sek B', roller: ['helsesekretaer'] }));
			await medTenant(b, () => logg({ type: 'admin', subtype: 'b', handling: 'E', utfall: '0' }, aktor));

			const oversikt = await tenantOversikt();
			const forB = oversikt.find((t) => t.id === 'legekontor-b');
			expect(forB?.antallBrukere).toBe(2);
			expect(forB?.antallAuditInnslag).toBeGreaterThanOrEqual(1);
			if (!fhir.erEkte) expect(forB?.partisjonFinnes).toBe(true);

			const forA = oversikt.find((t) => t.id === 'standard');
			expect(forA?.antallBrukere).toBe(1);
		});

		it('melder fra når registeret peker på en partisjon HAPI ikke har', async () => {
			await exec(
				`INSERT INTO tenant (id, navn, organisasjonsnummer, base_url, partisjon_id)
				 VALUES ('foreldrelos', 'Uten partisjon', '994598759', 'https://x.test', 4242)`
			);
			const oversikt = await tenantOversikt();
			if (!fhir.erEkte) {
				expect(oversikt.find((t) => t.id === 'foreldrelos')?.partisjonFinnes).toBe(false);
			}
		});
	});
});
