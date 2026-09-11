import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { one, exec, query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase, setIn } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { prescribe, getMedicationList, fornye, discontinue, synkHistory } from '../src/lib/server/integrations/sfm/index';
import { getRecipient, canReceive, searchRecipients, toPart } from '../src/lib/server/integrations/nhn/address-registry';
import { queueOut, listMessages, receiveMessage, registerApprec, sendQueue, pendingKvitteringer } from '../src/lib/server/integrations/nhn/message-queue';
import { buildDialogueMessage, buildReferral } from '../src/lib/server/integrations/nhn/messages';
import { readApprec } from '../src/lib/server/integrations/nhn/apprec';
import { getCopaymentStatus, EGENANDELSTAK_ORE } from '../src/lib/server/integrations/helfo/copayment';
import { getCard, listCard, createBillingCard } from '../src/lib/server/integrations/helfo/billing';
import { forhandsvis, generateSettlement, getSettlement, registerSettlementRun, sendSettlement } from '../src/lib/server/integrations/helfo/settlement';
import { fhirClient } from '../src/lib/server/fhir/client';
import { SYSTEM } from '../src/lib/server/fhir/codesystems';
import { parseXml, textValue } from '../src/lib/server/util/xml';
import type { AuditActor } from '../src/lib/server/audit';
import { newId } from '../src/lib/server/util/ids';

const describeIf = hasTestDatabase() ? describe : describe.skip;

const actor: AuditActor = {
	userId: 'bruker-1', actorRef: 'Practitioner/42', name: 'Dr. Ingrid Fastlege',
	role: 'behandler', clientId: null, ip: '192.0.2.10', requestId: 'req-1'
};

const practitioner = { name: 'Ingrid Fastlege', hpr: '9144889' };
const patientPart = { fnr: '13086510035', givenName: 'Anne', familyName: 'Bakken', birthDate: '1965-08-13', gender: 'K' as const };

describeIf('integrasjoner', () => {
	let db: TestDatabase;
	let fhir: TestFhirServer;
	let patientId = '';

	beforeAll(async () => {
		db = await createTestDatabase('integr');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});
	afterAll(async () => { await fhir.close(); await db.riv(); });

	beforeEach(async () => {
		await emptyTables();
		fhir.nullstill();
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-1', 'behandler', 'Dr. Ingrid Fastlege']);
		const p = await fhirClient.create({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: patientPart.fnr }],
			name: [{ family: 'Bakken', given: ['Anne'] }],
			birthDate: '1965-08-13'
		});
		patientId = p.resource.id as string;
	});

	// -----------------------------------------------------------------------
	describe('Sentral forskrivningsmodul', () => {
		const prescription = {
			patientId: '',
			forskriverHpr: '9144889',
			forskriverName: 'Ingrid Fastlege',
			medication: { name: 'Metformin', atc: 'A10BA02', strength: '500 mg', form: 'tablett' },
			dosage: '1 tablett morgen og kveld',
			quantity: '1',
			indication: 'Diabetes type 2'
		};

		it('forskriver og speiler resepten som FHIR MedicationRequest', async () => {
			const response = await prescribe({ ...prescription, patientId }, actor);
			expect(response.ok).toBe(true);
			expect(response.prescriptionId).toMatch(/^R/);

			const bundle = await fhirClient.search('MedicationRequest', new URLSearchParams({ patient: `Patient/${patientId}` }));
			expect(bundle.entry).toHaveLength(1);
			const mr = bundle.entry?.[0].resource;
			expect(mr?.status).toBe('active');
			expect((mr?.dosageInstruction as { text: string }[])[0].text).toBe('1 tablett morgen og kveld');
		});

		it('bygger legemiddellisten av det som er forskrevet', async () => {
			await prescribe({ ...prescription, patientId }, actor);
			const list = await getMedicationList(patientId, actor);
			expect(list.ok).toBe(true);
			expect(list.data?.medications).toHaveLength(1);
			expect(list.data?.medications[0].name).toContain('Metformin');
			expect(list.data?.source).toBe('sfm');
		});

		it('varsler om interaksjon', async () => {
			await prescribe({ ...prescription, patientId, medication: { name: 'Warfarin', atc: 'B01AA03' } }, actor);
			const response = await prescribe({ ...prescription, patientId, medication: { name: 'Ibux', atc: 'M01AE01' } }, actor);
			const alerts = (response.data as unknown as { alerts: string[] }).alerts;
			expect(alerts.join(' ')).toMatch(/ALVORLIG/);
			expect(alerts.join(' ')).toMatch(/blødningsrisiko/);
		});

		it('varsler om dobbeltforskrivning', async () => {
			await prescribe({ ...prescription, patientId }, actor);
			const response = await prescribe({ ...prescription, patientId }, actor);
			expect((response.data as unknown as { alerts: string[] }).alerts.join(' ')).toMatch(/DOBBELTFORSKRIVNING/);
		});

		it('seponerer og fornyer', async () => {
			const first = await prescribe({ ...prescription, patientId }, actor);
			const discontinued = await discontinue(patientId, first.prescriptionId as string, 'Bivirkninger', actor);
			expect(discontinued.ok).toBe(true);
			let list = await getMedicationList(patientId, actor);
			expect(list.data?.medications[0].status).toBe('seponert');

			const newValue = await prescribe({ ...prescription, patientId, medication: { name: 'Simvastatin', atc: 'C10AA01' } }, actor);
			const fornyet = await fornye(patientId, newValue.prescriptionId as string, actor);
			expect(fornyet.ok).toBe(true);
			list = await getMedicationList(patientId, actor);
			expect(list.data?.medications.filter((l) => l.status === 'aktiv')).toHaveLength(1);
		});

		it('logger hver operasjon i sikkerhetsloggen og i synk-historikken', async () => {
			await prescribe({ ...prescription, patientId }, actor);
			const log = await query<{ subtype: string; patient_id: string }>("SELECT subtype, patient_id FROM audit_event WHERE type_code = 'integrasjon'");
			expect(log.some((l) => l.subtype === 'sfm:forskriv' && l.patient_id === patientId)).toBe(true);
			const history = await synkHistory(patientId);
			expect(history.some((h) => h.operation === 'forskriv' && h.status === 'ok')).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	describe('Adresseregisteret', () => {
		it('søker opp kommunikasjonsparter', async () => {
			const match = await searchRecipients('Oslo universitetssykehus');
			expect(match).toHaveLength(1);
			expect(match[0].herId).toBe('8142519');
		});

		it('filtrerer på støttet meldingstype', async () => {
			const lab = await searchRecipients('', 'MEDLAB');
			expect(lab.every((p) => p.supportsMessages.includes('MEDLAB'))).toBe(true);
		});

		it('stopper sending til mottaker som ikke støtter meldingstypen', async () => {
			expect(await canReceive('8095763', 'HENVIS')).toMatchObject({ ok: false });
			expect(await canReceive('8142519', 'HENVIS')).toMatchObject({ ok: true });
			expect(await canReceive('0000000', 'HENVIS')).toMatchObject({ ok: false });
		});

		it('lager avsenderpart med HER-id og organisasjonsnummer', async () => {
			const part = toPart((await getRecipient('8142519'))!);
			expect(part.identifier.map((i) => i.type).sort()).toEqual(['ENH', 'HER']);
		});
	});

	// -----------------------------------------------------------------------
	describe('Meldingskø', () => {
		const layerReferral = (msgId: string) =>
			buildReferral({
				msgId,
				recipient: toPart({
					herId: '8142519', name: 'Oslo universitetssykehus HF', type: 'sykehus',
					supportsMessages: ['HENVIS'], active: true
				}),
				patient: patientPart,
				practitioner,
				problem: 'Behov for utredning.',
				hastegrad: 'ordinaer'
			});

		it('legger melding i kø og sender den', async () => {
			const msgId = newId();
			const result = await queueOut(
				{ message_type: 'HENVIS', msgId, patientId, recipientHer: '8142519', payloadXml: layerReferral(msgId), createdOf: 'bruker-1' },
				actor
			);
			expect(result.ok).toBe(true);

			const sent_at = await sendQueue();
			expect(sent_at.sent_at).toBe(1);
			const messages = await listMessages({ direction: 'ut' });
			expect(messages[0].status).toBe('sendt');
		});

		it('nekter å legge melding i kø til mottaker som ikke støtter typen', async () => {
			const msgId = newId();
			const result = await queueOut(
				{ message_type: 'HENVIS', msgId, patientId, recipientHer: '8095763', payloadXml: layerReferral(msgId), createdOf: 'bruker-1' },
				actor
			);
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/tar ikke imot/);
			expect(await listMessages({ direction: 'ut' })).toHaveLength(0);
		});

		it('registrerer applikasjonskvittering på riktig melding', async () => {
			const msgId = newId();
			await queueOut({ message_type: 'HENVIS', msgId, patientId, recipientHer: '8142519', payloadXml: layerReferral(msgId), createdOf: 'bruker-1' }, actor);
			await sendQueue();
			expect(await registerApprec(msgId, '1', [], 'Sykehuset')).toBe(true);
			const messages = await listMessages({ direction: 'ut' });
			expect(messages[0]).toMatchObject({ status: 'kvittert', apprec_status: '1' });
		});

		it('markerer avvist melding og tar vare på feilteksten', async () => {
			const msgId = newId();
			await queueOut({ message_type: 'HENVIS', msgId, patientId, recipientHer: '8142519', payloadXml: layerReferral(msgId), createdOf: 'bruker-1' }, actor);
			await sendQueue();
			await registerApprec(msgId, '3', [{ code: 'E30', text: 'Ukjent pasient' }], 'Sykehuset');
			const messages = await listMessages({ direction: 'ut' });
			expect(messages[0].status).toBe('avvist');
			expect(messages[0].status_detail).toMatch(/E30/);
		});

		it('finner sendte meldinger som mangler kvittering', async () => {
			const msgId = newId();
			await queueOut({ message_type: 'HENVIS', msgId, patientId, recipientHer: '8142519', payloadXml: layerReferral(msgId), createdOf: 'bruker-1' }, actor);
			await sendQueue();
			await exec("UPDATE message SET updated_at = now() - interval '3 hours' WHERE direction = 'ut'");
			expect(await pendingKvitteringer(60)).toHaveLength(1);
		});

		it('tar imot dialogmelding, kobler den til pasienten og bygger kvittering', async () => {
			const msgId = newId();
			const xml = buildDialogueMessage({
				msgId, type: 'foresporsel', content: 'Kan dere sende siste notat?',
				recipient: toPart({ herId: '8000001', name: 'Storgata Legesenter', type: 'fastlege', supportsMessages: ['DIALOG_FORESPORSEL'], active: true }),
				patient: patientPart, practitioner
			});
			const result = await receiveMessage(xml, actor);
			expect(result.ok).toBe(true);
			expect(result.apprecStatus).toBe('1');
			expect(readApprec(result.apprec as string)?.refMsgId).toBe(msgId);

			const inValue = await listMessages({ direction: 'inn' });
			expect(inValue[0].patient_id).toBe(patientId);
			expect(inValue[0].fhir_ref).toMatch(/^Communication\//);

			const bundle = await fhirClient.search('Communication', new URLSearchParams({ patient: `Patient/${patientId}` }));
			expect(bundle.entry).toHaveLength(1);
		});

		it('kvitterer med merknad når pasienten er ukjent', async () => {
			const msgId = newId();
			const xml = buildDialogueMessage({
				msgId, type: 'notat', content: 'Notat',
				recipient: toPart({ herId: '8000001', name: 'Storgata Legesenter', type: 'fastlege', supportsMessages: ['DIALOG_NOTAT'], active: true }),
				patient: { ...patientPart, fnr: '24035810281' }, practitioner
			});
			const result = await receiveMessage(xml, actor);
			expect(result.apprecStatus).toBe('2');
			expect(result.error.map((f) => f.code)).toContain('E30');
		});

		it('oppdager duplikat', async () => {
			const msgId = newId();
			const xml = buildDialogueMessage({
				msgId, type: 'notat', content: 'Notat',
				recipient: toPart({ herId: '8000001', name: 'Storgata Legesenter', type: 'fastlege', supportsMessages: ['DIALOG_NOTAT'], active: true }),
				patient: patientPart, practitioner
			});
			await receiveMessage(xml, actor);
			const andre = await receiveMessage(xml, actor);
			expect(andre.error.map((f) => f.code)).toContain('S02');
			expect(await listMessages({ direction: 'inn' })).toHaveLength(1);
		});

		it('avviser melding som ikke lar seg lese', async () => {
			const result = await receiveMessage('<dette er ikke gyldig', actor);
			expect(result.ok).toBe(false);
			expect(result.apprecStatus).toBe('3');
		});

		it('speiler epikrise som DocumentReference', async () => {
			const { buildDischargeSummary } = await import('../src/lib/server/integrations/nhn/messages');
			const msgId = newId();
			const xml = buildDischargeSummary({
				msgId,
				recipient: toPart({ herId: '8000001', name: 'Storgata Legesenter', type: 'fastlege', supportsMessages: ['EPIKRISE'], active: true }),
				patient: patientPart, practitioner,
				encounterFrom: '2026-01-01',
				diagnoses: [{ code: 'I10', text: 'Hypertensjon', hoveddiagnose: true }],
				sammendrag: 'Utskrevet i god form.'
			});
			await receiveMessage(xml, actor);
			const inValue = await listMessages({ direction: 'inn' });
			expect(inValue[0].fhir_ref).toMatch(/^DocumentReference\//);
		});
	});

	// -----------------------------------------------------------------------
	describe('Helfo - egenandel og frikort', () => {
		it('slår opp frikortstatus og logger oppslaget', async () => {
			const status = await getCopaymentStatus(patientId, '13086510035', actor);
			expect(status.patientId).toBe(patientId);
			expect(status.remainingOre).toBeLessThanOrEqual(EGENANDELSTAK_ORE);

			const log = await one<{ subtype: string; purpose_of_use: string }>("SELECT subtype, purpose_of_use FROM audit_event WHERE subtype = 'helfo:egenandel'");
			expect(log?.purpose_of_use).toBe('HPAYMT');
			expect(await query('SELECT 1 FROM copayment_lookup')).toHaveLength(1);
		});

		it('gir frikort for fødselsnummer som ender på åtte eller mer', async () => {
			const status = await getCopaymentStatus(patientId, '11061550188', actor);
			expect(status.hasExemptionCard).toBe(true);
			expect(status.remainingOre).toBe(0);
		});

		it('bruker mellomlager innenfor tidsvinduet', async () => {
			await getCopaymentStatus(patientId, '13086510035', actor);
			const andre = await getCopaymentStatus(patientId, '13086510035', actor);
			expect(andre.source).toBe('cache');
			expect(await query('SELECT 1 FROM copayment_lookup')).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	describe('Helfo - regningskort og oppgjør', () => {
		const newCard = (over: Record<string, unknown> = {}) => ({
			patientId,
			practitionerId: 'prac-42',
			hprNumber: '9144889',
			date: new Date().toISOString().slice(0, 10),
			kontakttype: 'kontor' as const,
			diagnosisCode: 'K86',
			tariffs: [{ tariff_code: '2ad', count: 1 }, { tariff_code: '701a', count: 2 }],
			...over
		});

		it('oppretter regningskort og speiler det som FHIR Claim', async () => {
			const response = await createBillingCard(newCard(), actor);
			expect(response.ok).toBe(true);
			expect(response.sumReimbursementOre).toBe(19_600 + 2 * 6_100);

			const card = await getCard(response.id as string);
			expect(card?.lines).toHaveLength(2);
			expect(card?.card.claim_id).toMatch(/^Claim\//);

			const bundle = await fhirClient.search('Claim', new URLSearchParams({ patient: `Patient/${patientId}` }));
			expect(bundle.entry).toHaveLength(1);
		});

		it('avviser kort som bryter takstreglene, uten å lagre noe', async () => {
			const response = await createBillingCard(newCard({ tariffs: [{ tariff_code: '2ad', count: 1 }, { tariff_code: '1ak', count: 1 }] }), actor);
			expect(response.ok).toBe(false);
			expect(response.error?.join(' ')).toMatch(/kan ikke kombineres/);
			expect(await listCard({})).toHaveLength(0);
		});

		it('setter egenandelen til null ved fritak for barn', async () => {
			const response = await createBillingCard(newCard({ patientAge: 10 }), actor);
			const card = await getCard(response.id as string);
			expect(card?.card.copayment_ore).toBe(0);
			expect(card?.card.exemption_reason).toBe('barn-under-16');
			// The reimbursement from Helfo is unaffected.
			expect(card?.card.reimbursement_ore).toBe(19_600 + 2 * 6_100);
		});

		it('genererer oppgjørsfil og markerer kortene som sendt', async () => {
			await createBillingCard(newCard(), actor);
			await createBillingCard(newCard(), actor);

			const today = new Date().toISOString().slice(0, 10);
			const forhand = await forhandsvis(today, today);
			expect(forhand.countCard).toBe(2);

			const settlement = await generateSettlement(today, today, actor);
			expect(settlement.ok).toBe(true);

			expect(await listCard({ status: 'klar' })).toHaveLength(0);
			expect(await listCard({ status: 'sendt' })).toHaveLength(2);

			const stored = await getSettlement(settlement.id as string);
			const xml = parseXml(stored?.file as string);
			expect(textValue(xml, 'Kravhode/AntallRegningskort')).toBe('2');
			expect(textValue(xml, 'Kravhode/SumRefusjon')).toBe(((2 * (19_600 + 2 * 6_100)) / 100).toFixed(2));
		});

		it('advarer om regningskort uten diagnosekode', async () => {
			await createBillingCard(newCard({ diagnosisCode: null }), actor);
			const today = new Date().toISOString().slice(0, 10);
			expect((await forhandsvis(today, today)).warnings.join(' ')).toMatch(/mangler diagnosekode/);
		});

		it('sender oppgjøret og registrerer avregning med avvisning', async () => {
			const card = await createBillingCard(newCard(), actor);
			const today = new Date().toISOString().slice(0, 10);
			const settlement = await generateSettlement(today, today, actor);
			expect((await sendSettlement(settlement.id as string, actor)).ok).toBe(true);

			const result = await registerSettlementRun(
				settlement.id as string,
				[{ cardId: card.id as string, approved: false, arsak: 'Takst 701a er ikke dokumentert' }],
				actor
			);
			expect(result).toMatchObject({ approved: 0, rejected: 1 });
			const rejected = await getCard(card.id as string);
			expect(rejected?.card.status).toBe('avvist');
			expect(rejected?.card.rejection).toMatch(/701a/);
		});

		it('nekter å sende et oppgjør to ganger', async () => {
			await createBillingCard(newCard(), actor);
			const today = new Date().toISOString().slice(0, 10);
			const settlement = await generateSettlement(today, today, actor);
			await sendSettlement(settlement.id as string, actor);
			expect((await sendSettlement(settlement.id as string, actor)).ok).toBe(false);
		});

		it('avviser oppgjør uten regningskort i perioden', async () => {
			const response = await generateSettlement('2020-01-01', '2020-01-31', actor);
			expect(response.ok).toBe(false);
		});
	});
});
