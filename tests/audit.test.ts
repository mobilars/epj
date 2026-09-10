import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { en, exec, query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase, settInn } from './fixtures/db';
import { hentAuditEvent, hentLogg, logg, ugjennomgattNodrett, verifiserLoggkjede, type AuditAktor } from '../src/lib/server/audit';
import { nyId } from '../src/lib/server/util/ids';

const kanKjore = harTestdatabase();
const beskriv = kanKjore ? describe : describe.skip;

const aktor: AuditAktor = {
	userId: 'bruker-1',
	actorRef: 'Practitioner/42',
	navn: 'Dr. Ingrid Fastlege',
	rolle: 'lege',
	clientId: null,
	ip: '192.0.2.10',
	requestId: 'req-1'
};

beskriv('sikkerhetslogg', () => {
	let db: Testdatabase;
	beforeAll(async () => { db = await opprettTestdatabase('audit'); });
	afterAll(async () => { await db.riv(); });
	beforeEach(async () => { await tomTabeller(); });

	it('skriver et fullstendig FHIR AuditEvent', async () => {
		await logg(
			{ type: 'rest', subtype: 'read', handling: 'R', utfall: '0', patientId: 'p1', entityRef: 'Observation/o1', purposeOfUse: 'TREAT' },
			aktor
		);
		const rad = await en<{ seq: number; content: Record<string, unknown> }>('SELECT seq, content FROM audit_event');
		expect(rad?.content.resourceType).toBe('AuditEvent');
		expect(rad?.content.action).toBe('R');
		const agent = (rad?.content.agent as { who: { reference: string } }[])[0];
		expect(agent.who.reference).toBe('Practitioner/42');
		const entity = rad?.content.entity as { what: { reference: string } }[];
		expect(entity[0].what.reference).toBe('Patient/p1');
	});

	it('lenker radene med hash', async () => {
		await logg({ type: 'rest', handling: 'R', utfall: '0' }, aktor);
		await logg({ type: 'rest', handling: 'C', utfall: '0' }, aktor);
		await logg({ type: 'rest', handling: 'U', utfall: '0' }, aktor);
		const rader = await query<{ seq: number; prev_hash: string; hash: string }>('SELECT seq, prev_hash, hash FROM audit_event ORDER BY seq');
		expect(rader[0].prev_hash).toBe('genesis');
		expect(rader[1].prev_hash).toBe(rader[0].hash);
		expect(rader[2].prev_hash).toBe(rader[1].hash);
	});

	it('verifiserer en uskadd kjede', async () => {
		for (let i = 0; i < 25; i++) await logg({ type: 'rest', handling: 'R', utfall: '0', patientId: `p${i}` }, aktor);
		const resultat = await verifiserLoggkjede();
		expect(resultat.gyldig).toBe(true);
		expect(resultat.kontrollerte).toBe(25);
	});

	it('nekter oppdatering og sletting i databasen', async () => {
		await logg({ type: 'rest', handling: 'R', utfall: '0' }, aktor);
		await expect(exec("UPDATE audit_event SET outcome = '4'")).rejects.toThrow(/append-only/);
		await expect(exec('DELETE FROM audit_event')).rejects.toThrow(/append-only/);
	});

	it('oppdager at en rad er fjernet', async () => {
		for (let i = 0; i < 5; i++) await logg({ type: 'rest', handling: 'R', utfall: '0', patientId: `p${i}` }, aktor);
		// Triggeren må kobles fra for å simulere et angrep på databasenivå.
		await exec('ALTER TABLE audit_event DISABLE TRIGGER trg_audit_append_only');
		await exec('DELETE FROM audit_event WHERE seq = (SELECT min(seq) + 2 FROM audit_event)');
		await exec('ALTER TABLE audit_event ENABLE TRIGGER trg_audit_append_only');

		const resultat = await verifiserLoggkjede();
		expect(resultat.gyldig).toBe(false);
		expect(resultat.forsteBrudd).toBeDefined();
	});

	it('oppdager at innholdet i en rad er endret', async () => {
		for (let i = 0; i < 3; i++) await logg({ type: 'rest', handling: 'R', utfall: '0', patientId: `p${i}` }, aktor);
		await exec('ALTER TABLE audit_event DISABLE TRIGGER trg_audit_append_only');
		await exec(`UPDATE audit_event SET content = jsonb_set(content, '{action}', '"C"') WHERE seq = (SELECT min(seq) FROM audit_event)`);
		await exec('ALTER TABLE audit_event ENABLE TRIGGER trg_audit_append_only');

		const resultat = await verifiserLoggkjede();
		expect(resultat.gyldig).toBe(false);
	});

	it('filtrerer loggen på pasient, bruker og tid', async () => {
		await logg({ type: 'rest', handling: 'R', utfall: '0', patientId: 'p1' }, aktor);
		await logg({ type: 'rest', handling: 'R', utfall: '0', patientId: 'p2' }, aktor);
		await logg({ type: 'login', handling: 'E', utfall: '0' }, { ...aktor, userId: 'bruker-2' });

		expect((await hentLogg({ patientId: 'p1' })).total).toBe(1);
		expect((await hentLogg({ userId: 'bruker-1' })).total).toBe(2);
		expect((await hentLogg({ type: 'login' })).total).toBe(1);
		expect((await hentLogg({ fra: new Date(Date.now() + 60_000).toISOString() })).total).toBe(0);
	});

	it('gjør innslaget tilgjengelig som FHIR-ressurs med id', async () => {
		const { seq } = await logg({ type: 'rest', handling: 'R', utfall: '0', patientId: 'p1' }, aktor);
		const event = await hentAuditEvent(seq);
		expect(event?.resourceType).toBe('AuditEvent');
		expect(event?.id).toBe(String(seq));
	});

	it('registrerer nødrettsoppslag med purposeOfUse ETREAT', async () => {
		await logg({ type: 'emergency-override', handling: 'R', utfall: '0', patientId: 'p9', purposeOfUse: 'ETREAT' }, aktor);
		const { rader } = await hentLogg({ kunNodrett: true });
		expect(rader).toHaveLength(1);
		expect(rader[0].purpose_of_use).toBe('ETREAT');
	});

	it('lister nødrettsoppslag som ikke er gjennomgått', async () => {
		await settInn('INSERT INTO user_account (id, brukernavn, navn) VALUES ($1,$2,$3)', ['bruker-1', 'lege', 'Lege']);
		await logg({ type: 'emergency-override', handling: 'R', utfall: '0', patientId: 'p9', purposeOfUse: 'ETREAT' }, aktor);
		expect(await ugjennomgattNodrett()).toHaveLength(1);

		await settInn(
			'INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper, gjennomgatt_tid) VALUES ($1,$2,$3,$4, now(), now())',
			[nyId(), 'bruker-1', 'p9', 'gjennomgått i ettertid']
		);
		expect(await ugjennomgattNodrett()).toHaveLength(0);
	});

	it('lagrer detaljer uten å miste dem', async () => {
		await logg(
			{ type: 'rest', handling: 'E', utfall: '0', detaljer: { antall: 12, spørring: 'status=active', tom: null } },
			aktor
		);
		const rad = await en<{ content: { entity: { detail: { type: { text: string }; valueString: string }[] }[] } }>('SELECT content FROM audit_event');
		const detaljer = rad?.content.entity[0].detail ?? [];
		expect(detaljer.map((d) => d.type.text)).toEqual(['antall', 'spørring']);
	});
});
