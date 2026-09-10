import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { en, exec, query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase, settInn } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { forskriv, hentLegemiddelliste, fornye, seponer, synkHistorikk } from '../src/lib/server/integrasjoner/sfm/index';
import { hentMottaker, kanMotta, sokMottakere, tilPart } from '../src/lib/server/integrasjoner/nhn/adresseregister';
import { koeUt, listMeldinger, mottaMelding, registrerApprec, sendKo, ventendeKvitteringer } from '../src/lib/server/integrasjoner/nhn/meldingsko';
import { byggDialogmelding, byggHenvisning } from '../src/lib/server/integrasjoner/nhn/meldinger';
import { lesApprec } from '../src/lib/server/integrasjoner/nhn/apprec';
import { hentEgenandelstatus, EGENANDELSTAK_ORE } from '../src/lib/server/integrasjoner/helfo/egenandel';
import { hentKort, listKort, opprettRegningskort } from '../src/lib/server/integrasjoner/helfo/regningskort';
import { forhandsvis, genererOppgjor, hentOppgjor, registrerAvregning, sendOppgjor } from '../src/lib/server/integrasjoner/helfo/oppgjor';
import { fhirKlient } from '../src/lib/server/fhir/client';
import { SYSTEM } from '../src/lib/server/fhir/kodeverk';
import { parseXml, tekstVerdi } from '../src/lib/server/util/xml';
import type { AuditAktor } from '../src/lib/server/audit';
import { nyId } from '../src/lib/server/util/ids';

const beskriv = harTestdatabase() ? describe : describe.skip;

const aktor: AuditAktor = {
	userId: 'bruker-1', actorRef: 'Practitioner/42', navn: 'Dr. Ingrid Fastlege',
	rolle: 'lege', clientId: null, ip: '192.0.2.10', requestId: 'req-1'
};

const behandler = { navn: 'Ingrid Fastlege', hpr: '9144889' };
const pasientPart = { fnr: '13086510035', fornavn: 'Anne', etternavn: 'Bakken', fodselsdato: '1965-08-13', kjonn: 'K' as const };

beskriv('integrasjoner', () => {
	let db: Testdatabase;
	let fhir: TestFhirServer;
	let patientId = '';

	beforeAll(async () => {
		db = await opprettTestdatabase('integr');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});
	afterAll(async () => { await fhir.lukk(); await db.riv(); });

	beforeEach(async () => {
		await tomTabeller();
		fhir.nullstill();
		await settInn('INSERT INTO user_account (id, brukernavn, navn) VALUES ($1,$2,$3)', ['bruker-1', 'lege', 'Dr. Ingrid Fastlege']);
		const p = await fhirKlient.opprett({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: pasientPart.fnr }],
			name: [{ family: 'Bakken', given: ['Anne'] }],
			birthDate: '1965-08-13'
		});
		patientId = p.ressurs.id as string;
	});

	// -----------------------------------------------------------------------
	describe('Sentral forskrivningsmodul', () => {
		const resept = {
			patientId: '',
			forskriverHpr: '9144889',
			forskriverNavn: 'Ingrid Fastlege',
			legemiddel: { navn: 'Metformin', atc: 'A10BA02', styrke: '500 mg', form: 'tablett' },
			dosering: '1 tablett morgen og kveld',
			mengde: '1',
			indikasjon: 'Diabetes type 2'
		};

		it('forskriver og speiler resepten som FHIR MedicationRequest', async () => {
			const svar = await forskriv({ ...resept, patientId }, aktor);
			expect(svar.ok).toBe(true);
			expect(svar.reseptId).toMatch(/^R/);

			const bundle = await fhirKlient.sok('MedicationRequest', new URLSearchParams({ patient: `Patient/${patientId}` }));
			expect(bundle.entry).toHaveLength(1);
			const mr = bundle.entry?.[0].resource;
			expect(mr?.status).toBe('active');
			expect((mr?.dosageInstruction as { text: string }[])[0].text).toBe('1 tablett morgen og kveld');
		});

		it('bygger legemiddellisten av det som er forskrevet', async () => {
			await forskriv({ ...resept, patientId }, aktor);
			const liste = await hentLegemiddelliste(patientId, aktor);
			expect(liste.ok).toBe(true);
			expect(liste.data?.legemidler).toHaveLength(1);
			expect(liste.data?.legemidler[0].navn).toContain('Metformin');
			expect(liste.data?.kilde).toBe('sfm');
		});

		it('varsler om interaksjon', async () => {
			await forskriv({ ...resept, patientId, legemiddel: { navn: 'Warfarin', atc: 'B01AA03' } }, aktor);
			const svar = await forskriv({ ...resept, patientId, legemiddel: { navn: 'Ibux', atc: 'M01AE01' } }, aktor);
			const varsler = (svar.data as unknown as { varsler: string[] }).varsler;
			expect(varsler.join(' ')).toMatch(/ALVORLIG/);
			expect(varsler.join(' ')).toMatch(/blødningsrisiko/);
		});

		it('varsler om dobbeltforskrivning', async () => {
			await forskriv({ ...resept, patientId }, aktor);
			const svar = await forskriv({ ...resept, patientId }, aktor);
			expect((svar.data as unknown as { varsler: string[] }).varsler.join(' ')).toMatch(/DOBBELTFORSKRIVNING/);
		});

		it('seponerer og fornyer', async () => {
			const forste = await forskriv({ ...resept, patientId }, aktor);
			const seponert = await seponer(patientId, forste.reseptId as string, 'Bivirkninger', aktor);
			expect(seponert.ok).toBe(true);
			let liste = await hentLegemiddelliste(patientId, aktor);
			expect(liste.data?.legemidler[0].status).toBe('seponert');

			const ny = await forskriv({ ...resept, patientId, legemiddel: { navn: 'Simvastatin', atc: 'C10AA01' } }, aktor);
			const fornyet = await fornye(patientId, ny.reseptId as string, aktor);
			expect(fornyet.ok).toBe(true);
			liste = await hentLegemiddelliste(patientId, aktor);
			expect(liste.data?.legemidler.filter((l) => l.status === 'aktiv')).toHaveLength(1);
		});

		it('logger hver operasjon i sikkerhetsloggen og i synk-historikken', async () => {
			await forskriv({ ...resept, patientId }, aktor);
			const logg = await query<{ subtype: string; patient_id: string }>("SELECT subtype, patient_id FROM audit_event WHERE type_code = 'integrasjon'");
			expect(logg.some((l) => l.subtype === 'sfm:forskriv' && l.patient_id === patientId)).toBe(true);
			const historikk = await synkHistorikk(patientId);
			expect(historikk.some((h) => h.operasjon === 'forskriv' && h.status === 'ok')).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	describe('Adresseregisteret', () => {
		it('søker opp kommunikasjonsparter', async () => {
			const treff = await sokMottakere('Oslo universitetssykehus');
			expect(treff).toHaveLength(1);
			expect(treff[0].herId).toBe('8142519');
		});

		it('filtrerer på støttet meldingstype', async () => {
			const lab = await sokMottakere('', 'MEDLAB');
			expect(lab.every((p) => p.stotterMeldinger.includes('MEDLAB'))).toBe(true);
		});

		it('stopper sending til mottaker som ikke støtter meldingstypen', async () => {
			expect(await kanMotta('8095763', 'HENVIS')).toMatchObject({ ok: false });
			expect(await kanMotta('8142519', 'HENVIS')).toMatchObject({ ok: true });
			expect(await kanMotta('0000000', 'HENVIS')).toMatchObject({ ok: false });
		});

		it('lager avsenderpart med HER-id og organisasjonsnummer', async () => {
			const part = tilPart((await hentMottaker('8142519'))!);
			expect(part.ident.map((i) => i.type).sort()).toEqual(['ENH', 'HER']);
		});
	});

	// -----------------------------------------------------------------------
	describe('Meldingskø', () => {
		const lagHenvisning = (msgId: string) =>
			byggHenvisning({
				msgId,
				mottaker: tilPart({
					herId: '8142519', navn: 'Oslo universitetssykehus HF', type: 'sykehus',
					stotterMeldinger: ['HENVIS'], aktiv: true
				}),
				pasient: pasientPart,
				behandler,
				problemstilling: 'Behov for utredning.',
				hastegrad: 'ordinaer'
			});

		it('legger melding i kø og sender den', async () => {
			const msgId = nyId();
			const resultat = await koeUt(
				{ meldingstype: 'HENVIS', msgId, patientId, mottakerHer: '8142519', payloadXml: lagHenvisning(msgId), opprettetAv: 'bruker-1' },
				aktor
			);
			expect(resultat.ok).toBe(true);

			const sendt = await sendKo();
			expect(sendt.sendt).toBe(1);
			const meldinger = await listMeldinger({ retning: 'ut' });
			expect(meldinger[0].status).toBe('sendt');
		});

		it('nekter å legge melding i kø til mottaker som ikke støtter typen', async () => {
			const msgId = nyId();
			const resultat = await koeUt(
				{ meldingstype: 'HENVIS', msgId, patientId, mottakerHer: '8095763', payloadXml: lagHenvisning(msgId), opprettetAv: 'bruker-1' },
				aktor
			);
			expect(resultat.ok).toBe(false);
			expect(resultat.feil).toMatch(/tar ikke imot/);
			expect(await listMeldinger({ retning: 'ut' })).toHaveLength(0);
		});

		it('registrerer applikasjonskvittering på riktig melding', async () => {
			const msgId = nyId();
			await koeUt({ meldingstype: 'HENVIS', msgId, patientId, mottakerHer: '8142519', payloadXml: lagHenvisning(msgId), opprettetAv: 'bruker-1' }, aktor);
			await sendKo();
			expect(await registrerApprec(msgId, '1', [], 'Sykehuset')).toBe(true);
			const meldinger = await listMeldinger({ retning: 'ut' });
			expect(meldinger[0]).toMatchObject({ status: 'kvittert', apprec_status: '1' });
		});

		it('markerer avvist melding og tar vare på feilteksten', async () => {
			const msgId = nyId();
			await koeUt({ meldingstype: 'HENVIS', msgId, patientId, mottakerHer: '8142519', payloadXml: lagHenvisning(msgId), opprettetAv: 'bruker-1' }, aktor);
			await sendKo();
			await registrerApprec(msgId, '3', [{ kode: 'E30', tekst: 'Ukjent pasient' }], 'Sykehuset');
			const meldinger = await listMeldinger({ retning: 'ut' });
			expect(meldinger[0].status).toBe('avvist');
			expect(meldinger[0].status_detalj).toMatch(/E30/);
		});

		it('finner sendte meldinger som mangler kvittering', async () => {
			const msgId = nyId();
			await koeUt({ meldingstype: 'HENVIS', msgId, patientId, mottakerHer: '8142519', payloadXml: lagHenvisning(msgId), opprettetAv: 'bruker-1' }, aktor);
			await sendKo();
			await exec("UPDATE melding SET oppdatert = now() - interval '3 hours' WHERE retning = 'ut'");
			expect(await ventendeKvitteringer(60)).toHaveLength(1);
		});

		it('tar imot dialogmelding, kobler den til pasienten og bygger kvittering', async () => {
			const msgId = nyId();
			const xml = byggDialogmelding({
				msgId, type: 'foresporsel', innhold: 'Kan dere sende siste notat?',
				mottaker: tilPart({ herId: '8000001', navn: 'Storgata Legesenter', type: 'fastlege', stotterMeldinger: ['DIALOG_FORESPORSEL'], aktiv: true }),
				pasient: pasientPart, behandler
			});
			const resultat = await mottaMelding(xml, aktor);
			expect(resultat.ok).toBe(true);
			expect(resultat.apprecStatus).toBe('1');
			expect(lesApprec(resultat.apprec as string)?.refMsgId).toBe(msgId);

			const inn = await listMeldinger({ retning: 'inn' });
			expect(inn[0].patient_id).toBe(patientId);
			expect(inn[0].fhir_ref).toMatch(/^Communication\//);

			const bundle = await fhirKlient.sok('Communication', new URLSearchParams({ patient: `Patient/${patientId}` }));
			expect(bundle.entry).toHaveLength(1);
		});

		it('kvitterer med merknad når pasienten er ukjent', async () => {
			const msgId = nyId();
			const xml = byggDialogmelding({
				msgId, type: 'notat', innhold: 'Notat',
				mottaker: tilPart({ herId: '8000001', navn: 'Storgata Legesenter', type: 'fastlege', stotterMeldinger: ['DIALOG_NOTAT'], aktiv: true }),
				pasient: { ...pasientPart, fnr: '24035810281' }, behandler
			});
			const resultat = await mottaMelding(xml, aktor);
			expect(resultat.apprecStatus).toBe('2');
			expect(resultat.feil.map((f) => f.kode)).toContain('E30');
		});

		it('oppdager duplikat', async () => {
			const msgId = nyId();
			const xml = byggDialogmelding({
				msgId, type: 'notat', innhold: 'Notat',
				mottaker: tilPart({ herId: '8000001', navn: 'Storgata Legesenter', type: 'fastlege', stotterMeldinger: ['DIALOG_NOTAT'], aktiv: true }),
				pasient: pasientPart, behandler
			});
			await mottaMelding(xml, aktor);
			const andre = await mottaMelding(xml, aktor);
			expect(andre.feil.map((f) => f.kode)).toContain('S02');
			expect(await listMeldinger({ retning: 'inn' })).toHaveLength(1);
		});

		it('avviser melding som ikke lar seg lese', async () => {
			const resultat = await mottaMelding('<dette er ikke gyldig', aktor);
			expect(resultat.ok).toBe(false);
			expect(resultat.apprecStatus).toBe('3');
		});

		it('speiler epikrise som DocumentReference', async () => {
			const { byggEpikrise } = await import('../src/lib/server/integrasjoner/nhn/meldinger');
			const msgId = nyId();
			const xml = byggEpikrise({
				msgId,
				mottaker: tilPart({ herId: '8000001', navn: 'Storgata Legesenter', type: 'fastlege', stotterMeldinger: ['EPIKRISE'], aktiv: true }),
				pasient: pasientPart, behandler,
				kontaktFra: '2026-01-01',
				diagnoser: [{ kode: 'I10', tekst: 'Hypertensjon', hoveddiagnose: true }],
				sammendrag: 'Utskrevet i god form.'
			});
			await mottaMelding(xml, aktor);
			const inn = await listMeldinger({ retning: 'inn' });
			expect(inn[0].fhir_ref).toMatch(/^DocumentReference\//);
		});
	});

	// -----------------------------------------------------------------------
	describe('Helfo - egenandel og frikort', () => {
		it('slår opp frikortstatus og logger oppslaget', async () => {
			const status = await hentEgenandelstatus(patientId, '13086510035', aktor);
			expect(status.patientId).toBe(patientId);
			expect(status.gjenstaendeOre).toBeLessThanOrEqual(EGENANDELSTAK_ORE);

			const logg = await en<{ subtype: string; purpose_of_use: string }>("SELECT subtype, purpose_of_use FROM audit_event WHERE subtype = 'helfo:egenandel'");
			expect(logg?.purpose_of_use).toBe('HPAYMT');
			expect(await query('SELECT 1 FROM egenandel_oppslag')).toHaveLength(1);
		});

		it('gir frikort for fødselsnummer som ender på åtte eller mer', async () => {
			const status = await hentEgenandelstatus(patientId, '11061550188', aktor);
			expect(status.harFrikort).toBe(true);
			expect(status.gjenstaendeOre).toBe(0);
		});

		it('bruker mellomlager innenfor tidsvinduet', async () => {
			await hentEgenandelstatus(patientId, '13086510035', aktor);
			const andre = await hentEgenandelstatus(patientId, '13086510035', aktor);
			expect(andre.kilde).toBe('cache');
			expect(await query('SELECT 1 FROM egenandel_oppslag')).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	describe('Helfo - regningskort og oppgjør', () => {
		const nyttKort = (over: Record<string, unknown> = {}) => ({
			patientId,
			behandlerId: 'prac-42',
			hprNummer: '9144889',
			dato: new Date().toISOString().slice(0, 10),
			kontakttype: 'kontor' as const,
			diagnoseKode: 'K86',
			takster: [{ takstkode: '2ad', antall: 1 }, { takstkode: '701a', antall: 2 }],
			...over
		});

		it('oppretter regningskort og speiler det som FHIR Claim', async () => {
			const svar = await opprettRegningskort(nyttKort(), aktor);
			expect(svar.ok).toBe(true);
			expect(svar.sumRefusjonOre).toBe(19_600 + 2 * 6_100);

			const kort = await hentKort(svar.id as string);
			expect(kort?.linjer).toHaveLength(2);
			expect(kort?.kort.claim_id).toMatch(/^Claim\//);

			const bundle = await fhirKlient.sok('Claim', new URLSearchParams({ patient: `Patient/${patientId}` }));
			expect(bundle.entry).toHaveLength(1);
		});

		it('avviser kort som bryter takstreglene, uten å lagre noe', async () => {
			const svar = await opprettRegningskort(nyttKort({ takster: [{ takstkode: '2ad', antall: 1 }, { takstkode: '1ak', antall: 1 }] }), aktor);
			expect(svar.ok).toBe(false);
			expect(svar.feil?.join(' ')).toMatch(/kan ikke kombineres/);
			expect(await listKort({})).toHaveLength(0);
		});

		it('setter egenandelen til null ved fritak for barn', async () => {
			const svar = await opprettRegningskort(nyttKort({ pasientAlder: 10 }), aktor);
			const kort = await hentKort(svar.id as string);
			expect(kort?.kort.egenandel_ore).toBe(0);
			expect(kort?.kort.fritak_grunn).toBe('barn-under-16');
			// Refusjonen fra Helfo påvirkes ikke.
			expect(kort?.kort.refusjon_ore).toBe(19_600 + 2 * 6_100);
		});

		it('genererer oppgjørsfil og markerer kortene som sendt', async () => {
			await opprettRegningskort(nyttKort(), aktor);
			await opprettRegningskort(nyttKort(), aktor);

			const idag = new Date().toISOString().slice(0, 10);
			const forhand = await forhandsvis(idag, idag);
			expect(forhand.antallKort).toBe(2);

			const oppgjor = await genererOppgjor(idag, idag, aktor);
			expect(oppgjor.ok).toBe(true);

			expect(await listKort({ status: 'klar' })).toHaveLength(0);
			expect(await listKort({ status: 'sendt' })).toHaveLength(2);

			const lagret = await hentOppgjor(oppgjor.id as string);
			const xml = parseXml(lagret?.fil as string);
			expect(tekstVerdi(xml, 'Kravhode/AntallRegningskort')).toBe('2');
			expect(tekstVerdi(xml, 'Kravhode/SumRefusjon')).toBe(((2 * (19_600 + 2 * 6_100)) / 100).toFixed(2));
		});

		it('advarer om regningskort uten diagnosekode', async () => {
			await opprettRegningskort(nyttKort({ diagnoseKode: null }), aktor);
			const idag = new Date().toISOString().slice(0, 10);
			expect((await forhandsvis(idag, idag)).advarsler.join(' ')).toMatch(/mangler diagnosekode/);
		});

		it('sender oppgjøret og registrerer avregning med avvisning', async () => {
			const kort = await opprettRegningskort(nyttKort(), aktor);
			const idag = new Date().toISOString().slice(0, 10);
			const oppgjor = await genererOppgjor(idag, idag, aktor);
			expect((await sendOppgjor(oppgjor.id as string, aktor)).ok).toBe(true);

			const resultat = await registrerAvregning(
				oppgjor.id as string,
				[{ kortId: kort.id as string, godkjent: false, arsak: 'Takst 701a er ikke dokumentert' }],
				aktor
			);
			expect(resultat).toMatchObject({ godkjent: 0, avvist: 1 });
			const avvist = await hentKort(kort.id as string);
			expect(avvist?.kort.status).toBe('avvist');
			expect(avvist?.kort.avvisning).toMatch(/701a/);
		});

		it('nekter å sende et oppgjør to ganger', async () => {
			await opprettRegningskort(nyttKort(), aktor);
			const idag = new Date().toISOString().slice(0, 10);
			const oppgjor = await genererOppgjor(idag, idag, aktor);
			await sendOppgjor(oppgjor.id as string, aktor);
			expect((await sendOppgjor(oppgjor.id as string, aktor)).ok).toBe(false);
		});

		it('avviser oppgjør uten regningskort i perioden', async () => {
			const svar = await genererOppgjor('2020-01-01', '2020-01-31', aktor);
			expect(svar.ok).toBe(false);
		});
	});
});
