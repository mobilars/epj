import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, createTestDatabase, setIn, emptyTables, type TestDatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { appContext } from './fixtures/context';
import { fhirClient } from '../src/platform/server/fhir/client';
import { SYSTEM } from '../src/platform/server/fhir/codesystems';
import { execute } from '../src/platform/server/fhir/gateway';
import { fhirBaseFor, requireTenant } from '../src/platform/server/tenant/context';
import { ensurePractitioner } from '../src/platform/server/auth/practitioner';
import { getUser, type User } from '../src/platform/server/auth/users';
import { newId } from '../src/platform/server/util/ids';

const describeIf = hasTestDatabase() ? describe : describe.skip;

describeIf('the Practitioner a clinician signs as', () => {
	let db: TestDatabase;
	let fhir: TestFhirServer;

	beforeAll(async () => {
		db = await createTestDatabase('practitioner');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});

	afterAll(async () => {
		await fhir.close();
		await db.riv();
	});

	beforeEach(async () => {
		await emptyTables();
		fhir.nullstill();
	});

	const account = async (hpr: string | null = null): Promise<User> => {
		const id = newId();
		await setIn('INSERT INTO user_account (id, username, name, hpr_number) VALUES ($1,$2,$3,$4)', [id, `u-${id}`, 'Anne Lege', hpr]);
		return (await getUser(id)) as User;
	};

	it('makes one for a behandler without, and remembers it', async () => {
		const user = await account();
		const id = await ensurePractitioner(user, ['behandler']);
		expect(id).toBeTruthy();
		expect((await getUser(user.id))?.practitioner_id).toBe(id);
		expect((await fhirClient.read('Practitioner', id as string)).name).toEqual([{ text: 'Anne Lege' }]);
	});

	it('makes one only, however many requests arrive at once', async () => {
		const user = await account();
		const ids = await Promise.all(Array.from({ length: 5 }, () => ensurePractitioner(user, ['behandler'])));
		expect(new Set(ids).size).toBe(1);
	});

	it('uses the one already there for that HPR-nummer', async () => {
		const number = String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
		const existing = await fhirClient.create({ resourceType: 'Practitioner', identifier: [{ system: SYSTEM.HPR, value: number }], name: [{ text: 'Anne Lege' }] });
		expect(await ensurePractitioner(await account(number), ['behandler'])).toBe(existing.resource.id);
	});

	it('leaves alone anyone who does not write in a record as its author', async () => {
		const user = await account();
		expect(await ensurePractitioner(user, ['resepsjon', 'systemansvarlig'])).toBeNull();
		expect((await getUser(user.id))?.practitioner_id).toBeNull();
	});

	it('does not stop a sign-in when the FHIR server cannot be reached', async () => {
		const user = await account();
		const reachable = process.env.EPJ_HAPI_BASE_URL;
		process.env.EPJ_HAPI_BASE_URL = 'http://127.0.0.1:1/fhir';
		try {
			expect(await ensurePractitioner(user, ['behandler'])).toBeNull();
		} finally {
			process.env.EPJ_HAPI_BASE_URL = reachable;
		}
		expect(await ensurePractitioner(user, ['behandler'])).toBeTruthy();
	});

	it("stores an app's absolute fhirUser as a reference to this record", async () => {
		const practitioner = await fhirClient.create({ resourceType: 'Practitioner', name: [{ text: 'Anne Lege' }] });
		const patient = await fhirClient.create({ resourceType: 'Patient', name: [{ family: 'Bakken' }] });
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-1', 'ingrid', 'Dr. Ingrid Fastlege']);
		await setIn('INSERT INTO care_relationship (id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4)', [newId(), 'bruker-1', patient.resource.id, 'fastlege']);
		const author = `${fhirBaseFor(requireTenant())}/Practitioner/${practitioner.resource.id}`;
		const elsewhere = 'https://other.example/fhir/Practitioner/1';

		const response = await execute({
			ctx: appContext('patient/Composition.c', patient.resource.id as string),
			method: 'POST',
			path: 'Composition',
			query: new URLSearchParams(),
			body: {
				resourceType: 'Composition',
				status: 'final',
				type: { text: 'Notat' },
				subject: { reference: `Patient/${patient.resource.id}` },
				date: '2026-10-31T10:00:00Z',
				title: author,
				author: [{ reference: author }, { reference: elsewhere }]
			}
		} as never);

		const stored = await fhirClient.read('Composition', response.resource.id as string);
		expect(stored.author).toEqual([{ reference: `Practitioner/${practitioner.resource.id}` }, { reference: elsewhere }]);
		expect(stored.title).toBe(author);
	});
});
