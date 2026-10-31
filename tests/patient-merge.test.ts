import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/platform/server/db/index';
import { hasTestDatabase, createTestDatabase, setIn, emptyTables, type TestDatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { context } from './fixtures/context';
import { fhirClient } from '../src/platform/server/fhir/client';
import { SYSTEM } from '../src/platform/server/fhir/codesystems';
import { keptPatientFor, mergeCandidate, mergedPatientIds, mergePatients, repointReferences } from '../src/platform/server/journal/patient-merge';
import { patientsWithNationalId } from '../src/platform/server/journal/patientdetails';
import { getLog, log } from '../src/platform/server/audit';
import { hasCareRelationship } from '../src/platform/server/authz/access';
import { newId } from '../src/platform/server/util/ids';

// Its own in each test: a real FHIR server is not emptied between them.
let NUMBER = '';

describe('pointing references at another patient', () => {
	it('changes references to that patient, wherever they are, and nothing else', () => {
		const resource = {
			subject: { reference: 'Patient/a' },
			nested: [{ actor: { reference: 'http://x/fhir/Patient/a' } }, { actor: { reference: 'Patient/ab' } }],
			note: { text: 'Patient/a' },
			performer: { reference: 'Practitioner/a' }
		};
		expect(repointReferences(resource, 'a', 'b')).toBe(true);
		expect(resource.subject.reference).toBe('Patient/b');
		expect(resource.nested[0].actor.reference).toBe('http://x/fhir/Patient/b');
		expect(resource.nested[1].actor.reference).toBe('Patient/ab');
		expect(resource.note.text).toBe('Patient/a');
		expect(resource.performer.reference).toBe('Practitioner/a');
	});

	it('says when there was nothing to change', () => {
		expect(repointReferences({ subject: { reference: 'Patient/c' } }, 'a', 'b')).toBe(false);
	});
});

const describeIf = hasTestDatabase() ? describe : describe.skip;

describeIf('joining two records of one person', () => {
	let db: TestDatabase;
	let fhir: TestFhirServer;
	let kept = '';
	let merged = '';
	const moveInApps = async () => undefined;
	const ctx = context({ userId: 'bruker-1', roles: ['behandler'] });

	const run = (reason = 'Registrert to ganger ved en feil') =>
		mergePatients(ctx, { keptId: kept, mergedId: merged, reason, moveInApps });

	beforeAll(async () => {
		db = await createTestDatabase('merge');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});

	afterAll(async () => {
		await fhir.close();
		await db.riv();
	});

	beforeEach(async () => {
		NUMBER = String(10_000_000_000 + Math.floor(Math.random() * 89_999_999_999));
		await emptyTables();
		await query('DELETE FROM patient_merge');
		fhir.nullstill();
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-1', 'behandler', 'Behandler']);
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-2', 'kollega', 'Kollega']);

		const person = () => ({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: NUMBER }],
			name: [{ use: 'official', family: 'Bakken', given: ['Anne'] }],
			telecom: [{ system: 'phone', value: '90000000' }],
			birthDate: '1965-08-13'
		});
		kept = (await fhirClient.create(person())).resource.id as string;
		merged = (await fhirClient.create(person())).resource.id as string;

		await fhirClient.create({
			resourceType: 'Observation',
			status: 'final',
			code: { text: 'Vekt' },
			subject: { reference: `Patient/${merged}` },
			valueQuantity: { value: 80, unit: 'kg' }
		});
		await fhirClient.create({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { text: 'Diabetes' },
			subject: { reference: `Patient/${merged}` }
		});
		await setIn('INSERT INTO care_relationship (id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4)', [newId(), 'bruker-2', merged, 'fastlege']);
	});

	const contents = async (id: string) =>
		((await fhirClient.everything(id)).entry ?? []).map((e) => e.resource as Record<string, unknown>).filter((r) => r.resourceType !== 'Patient');

	// The test double does not page, so this one means something only against real HAPI.
	it.runIf(process.env.EPJ_USE_REAL_HAPI === '1')('moves a long history, over several pages of results', async () => {
		const entry = Array.from({ length: 620 }, () => ({
			request: { method: 'POST', url: 'Observation' },
			resource: { resourceType: 'Observation', status: 'final', code: { text: 'Puls' }, subject: { reference: `Patient/${merged}` } }
		}));
		await fhirClient.transaction({ resourceType: 'Bundle', type: 'transaction', entry } as never);

		const { moved } = await run();
		expect(moved).toBe(622);
		const left = await fhirClient.search('Observation', new URLSearchParams({ patient: merged, _summary: 'count' }));
		expect(left.total).toBe(0);
		const arrived = await fhirClient.search('Observation', new URLSearchParams({ patient: kept, _summary: 'count' }));
		expect(arrived.total).toBe(621);
	}, 120_000);

	it('moves everything in the record to the one kept', async () => {
		const { moved } = await run();
		expect(moved).toBe(2);
		const types = (await contents(kept)).map((r) => r.resourceType).sort();
		expect(types).toEqual(['Condition', 'Observation']);
		expect(await contents(merged)).toEqual([]);
	});

	it('leaves the other record in place, saying what replaced it', async () => {
		await run();
		const old = await fhirClient.read('Patient', merged);
		expect(old.active).toBe(false);
		expect(old.link).toEqual([{ other: { reference: `Patient/${kept}` }, type: 'replaced-by' }]);
		expect((old.name as unknown[]).length).toBe(1);
		const current = await fhirClient.read('Patient', kept);
		expect(current.link).toEqual([{ other: { reference: `Patient/${merged}` }, type: 'replaces' }]);
	});

	it('leaves one record to be found by the number, so it can be registered no third time', async () => {
		expect((await patientsWithNationalId(NUMBER)).map((p) => p.id).sort()).toEqual([kept, merged].sort());
		await run();
		expect((await patientsWithNationalId(NUMBER)).map((p) => p.id)).toEqual([kept]);
	});

	it('hands access to whoever had the other record', async () => {
		expect(await hasCareRelationship('bruker-2', kept)).toBe(false);
		await run();
		expect(await hasCareRelationship('bruker-2', kept)).toBe(true);
	});

	it("carries a restriction with it: a patient's block must not be lost", async () => {
		await setIn(
			`INSERT INTO record_restriction (id, patient_id, scope_extent, target_user_id, registered_by, justification)
			 VALUES ($1,$2,'bruker',$3,$4,$5)`,
			[newId(), merged, 'bruker-1', 'bruker-2', 'Ønsket av pasienten']
		);
		await run();
		const rows = await query<{ patient_id: string }>('SELECT patient_id FROM record_restriction');
		expect(rows.map((r) => r.patient_id)).toEqual([kept]);
	});

	it('finds the kept record from the old one, and keeps the access log whole', async () => {
		await log(
			{ type: 'rest', subtype: 'read', action: 'R', outcome: '0', patientId: merged },
			{ userId: 'bruker-2', actorRef: 'Practitioner/x', name: 'Kollega', role: 'behandler', clientId: null, ip: '127.0.0.1', requestId: 'r' }
		);
		await run();
		expect(await keptPatientFor(merged)).toBe(kept);
		expect(await keptPatientFor(kept)).toBeNull();
		expect(await mergedPatientIds(kept)).toEqual([merged]);

		const { rows } = await getLog({ patientIds: [kept, ...(await mergedPatientIds(kept))] });
		expect(rows.some((r) => r.patient_id === merged)).toBe(true);
	});

	it('follows a chain of merges', async () => {
		await run();
		const third = (await fhirClient.create({ resourceType: 'Patient', name: [{ family: 'Bakken' }] })).resource.id as string;
		await mergePatients(ctx, { keptId: third, mergedId: kept, reason: 'Også registrert en tredje gang', moveInApps });
		expect((await mergedPatientIds(third)).sort()).toEqual([kept, merged].sort());
	});

	it('refuses to do it twice, or a patient with itself, or into a merged record', async () => {
		await expect(mergePatients(ctx, { keptId: kept, mergedId: kept, reason: 'x', moveInApps })).rejects.toThrow();
		await run();
		await expect(run()).rejects.toThrow('already been merged');
		const third = (await fhirClient.create({ resourceType: 'Patient', name: [{ family: 'X' }] })).resource.id as string;
		await expect(mergePatients(ctx, { keptId: merged, mergedId: third, reason: 'x', moveInApps })).rejects.toThrow('itself been merged');
	});

	it('records nothing if it fails half way, and can then be run again', async () => {
		const failing = async () => {
			throw new Error('an app failed');
		};
		await expect(mergePatients(ctx, { keptId: kept, mergedId: merged, reason: 'Registrert to ganger', moveInApps: failing })).rejects.toThrow();
		expect(await keptPatientFor(merged)).toBeNull();
		expect((await fhirClient.read('Patient', merged)).active).not.toBe(false);
		expect(await query('SELECT id FROM care_relationship WHERE patient_id = $1', [merged])).toHaveLength(1);

		await run();
		expect(await keptPatientFor(merged)).toBe(kept);
		expect((await contents(kept)).length).toBe(2);
	});

	it('shows counts and identity in the preview, not content', async () => {
		const candidate = await mergeCandidate(await fhirClient.read('Patient', merged), NUMBER);
		expect(candidate.sameNumber).toBe(true);
		expect(candidate.counts.map((c) => c.count)).toEqual([1, 1]);
		expect(JSON.stringify(candidate)).not.toContain('Diabetes');
		expect(JSON.stringify(candidate)).not.toContain(NUMBER);
	});
});
