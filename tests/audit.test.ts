import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { one, exec, query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase, setIn } from './fixtures/db';
import { getAuditEvent, getLog, log, unreviewedEmergencyAccess, verifyLogChain, type AuditActor } from '../src/lib/server/audit';
import { newId } from '../src/lib/server/util/ids';

const canRun = hasTestDatabase();
const describeIf = canRun ? describe : describe.skip;

const actor: AuditActor = {
	userId: 'bruker-1',
	actorRef: 'Practitioner/42',
	name: 'Dr. Ingrid Fastlege',
	role: 'lege',
	clientId: null,
	ip: '192.0.2.10',
	requestId: 'req-1'
};

describeIf('sikkerhetslogg', () => {
	let db: TestDatabase;
	beforeAll(async () => { db = await createTestDatabase('audit'); });
	afterAll(async () => { await db.riv(); });
	beforeEach(async () => { await emptyTables(); });

	it('skriver et fullstendig FHIR AuditEvent', async () => {
		await log(
			{ type: 'rest', subtype: 'read', action: 'R', outcome: '0', patientId: 'p1', entityRef: 'Observation/o1', purposeOfUse: 'TREAT' },
			actor
		);
		const row = await one<{ seq: number; content: Record<string, unknown> }>('SELECT seq, content FROM audit_event');
		expect(row?.content.resourceType).toBe('AuditEvent');
		expect(row?.content.action).toBe('R');
		const agent = (row?.content.agent as { who: { reference: string } }[])[0];
		expect(agent.who.reference).toBe('Practitioner/42');
		const entity = row?.content.entity as { what: { reference: string } }[];
		expect(entity[0].what.reference).toBe('Patient/p1');
	});

	it('lenker radene med hash', async () => {
		await log({ type: 'rest', action: 'R', outcome: '0' }, actor);
		await log({ type: 'rest', action: 'C', outcome: '0' }, actor);
		await log({ type: 'rest', action: 'U', outcome: '0' }, actor);
		const rows = await query<{ seq: number; prev_hash: string; hash: string }>('SELECT seq, prev_hash, hash FROM audit_event ORDER BY seq');
		expect(rows[0].prev_hash).toBe('genesis');
		expect(rows[1].prev_hash).toBe(rows[0].hash);
		expect(rows[2].prev_hash).toBe(rows[1].hash);
	});

	it('verifiserer en uskadd kjede', async () => {
		for (let i = 0; i < 25; i++) await log({ type: 'rest', action: 'R', outcome: '0', patientId: `p${i}` }, actor);
		const result = await verifyLogChain();
		expect(result.valid).toBe(true);
		expect(result.checked).toBe(25);
	});

	it('nekter oppdatering og sletting i databasen', async () => {
		await log({ type: 'rest', action: 'R', outcome: '0' }, actor);
		await expect(exec("UPDATE audit_event SET outcome = '4'")).rejects.toThrow(/append-only/);
		await expect(exec('DELETE FROM audit_event')).rejects.toThrow(/append-only/);
	});

	it('oppdager at en rad er fjernet', async () => {
		for (let i = 0; i < 5; i++) await log({ type: 'rest', action: 'R', outcome: '0', patientId: `p${i}` }, actor);
		// Triggeren må kobles fra for å simulere et angrep på databasenivå.
		await exec('ALTER TABLE audit_event DISABLE TRIGGER trg_audit_append_only');
		await exec('DELETE FROM audit_event WHERE seq = (SELECT min(seq) + 2 FROM audit_event)');
		await exec('ALTER TABLE audit_event ENABLE TRIGGER trg_audit_append_only');

		const result = await verifyLogChain();
		expect(result.valid).toBe(false);
		expect(result.firstBrudd).toBeDefined();
	});

	it('oppdager at innholdet i en rad er endret', async () => {
		for (let i = 0; i < 3; i++) await log({ type: 'rest', action: 'R', outcome: '0', patientId: `p${i}` }, actor);
		await exec('ALTER TABLE audit_event DISABLE TRIGGER trg_audit_append_only');
		await exec(`UPDATE audit_event SET content = jsonb_set(content, '{action}', '"C"') WHERE seq = (SELECT min(seq) FROM audit_event)`);
		await exec('ALTER TABLE audit_event ENABLE TRIGGER trg_audit_append_only');

		const result = await verifyLogChain();
		expect(result.valid).toBe(false);
	});

	it('filtrerer loggen på pasient, bruker og tid', async () => {
		await log({ type: 'rest', action: 'R', outcome: '0', patientId: 'p1' }, actor);
		await log({ type: 'rest', action: 'R', outcome: '0', patientId: 'p2' }, actor);
		await log({ type: 'login', action: 'E', outcome: '0' }, { ...actor, userId: 'bruker-2' });

		expect((await getLog({ patientId: 'p1' })).total).toBe(1);
		expect((await getLog({ userId: 'bruker-1' })).total).toBe(2);
		expect((await getLog({ type: 'login' })).total).toBe(1);
		expect((await getLog({ from: new Date(Date.now() + 60_000).toISOString() })).total).toBe(0);
	});

	it('gjør innslaget tilgjengelig som FHIR-ressurs med id', async () => {
		const { seq } = await log({ type: 'rest', action: 'R', outcome: '0', patientId: 'p1' }, actor);
		const event = await getAuditEvent(seq);
		expect(event?.resourceType).toBe('AuditEvent');
		expect(event?.id).toBe(String(seq));
	});

	it('registrerer nødrettsoppslag med purposeOfUse ETREAT', async () => {
		await log({ type: 'emergency-override', action: 'R', outcome: '0', patientId: 'p9', purposeOfUse: 'ETREAT' }, actor);
		const { rows } = await getLog({ onlyEmergencyAccess: true });
		expect(rows).toHaveLength(1);
		expect(rows[0].purpose_of_use).toBe('ETREAT');
	});

	it('lister nødrettsoppslag som ikke er gjennomgått', async () => {
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-1', 'lege', 'Lege']);
		await log({ type: 'emergency-override', action: 'R', outcome: '0', patientId: 'p9', purposeOfUse: 'ETREAT' }, actor);
		expect(await unreviewedEmergencyAccess()).toHaveLength(1);

		await setIn(
			'INSERT INTO break_glass (id, user_id, patient_id, justification, expires_at, reviewed_at) VALUES ($1,$2,$3,$4, now(), now())',
			[newId(), 'bruker-1', 'p9', 'gjennomgått i ettertid']
		);
		expect(await unreviewedEmergencyAccess()).toHaveLength(0);
	});

	it('lagrer detaljer uten å miste dem', async () => {
		await log(
			{ type: 'rest', action: 'E', outcome: '0', details: { antall: 12, 'spørring': 'status=aktiv', tom: null } },
			actor
		);
		const row = await one<{ content: { entity: { detail: { type: { text: string }; valueString: string }[] }[] } }>('SELECT content FROM audit_event');
		const details = row?.content.entity[0].detail ?? [];
		expect(details.map((d) => d.type.text)).toEqual(['antall', 'spørring']);
	});
});
