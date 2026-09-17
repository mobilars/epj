import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase, createTestDatabase, type TestDatabase } from './fixtures/db';
import { acceptedActions, type Suggestion } from '../src/lib/server/cds/hooks';
import { ageYears, bmi, bmiClass, egfrCkdEpi2021, gfrCategory } from '../src/lib/server/cds/calculators';
import { HookCallerError, requireHookCaller, signHookRequest } from '../src/lib/server/cds/signing';
import { sign } from '../src/lib/server/auth/jws';
import { config } from '../src/lib/server/config';
import type { RequestEvent } from '@sveltejs/kit';

const describeIf = hasTestDatabase() ? describe : describe.skip;

/**
 * What a suggestion may do when pressed.
 *
 * The service proposes; the clinician's press is the write. These pin down
 * the shape of what gets through: new resources about this patient, and
 * nothing else.
 */
describe('CDS suggestions', () => {
	const serviceRequest = (patient: string, extra: Record<string, unknown> = {}) => ({
		resourceType: 'ServiceRequest',
		status: 'active',
		intent: 'order',
		subject: { reference: `Patient/${patient}` },
		...extra
	});

	it('lets a suggestion create a resource about the patient it was about', () => {
		const s: Suggestion = { label: 'Rekvirer HbA1c', actions: [{ type: 'create', resource: serviceRequest('p1') }] };
		const { resources, refused } = acceptedActions(s, 'p1');
		expect(resources).toHaveLength(1);
		expect(refused).toEqual([]);
	});

	it('refuses to write about another patient, even from a well-formed suggestion', () => {
		const s: Suggestion = { label: 'x', actions: [{ type: 'create', resource: serviceRequest('p2') }] };
		const { resources, refused } = acceptedActions(s, 'p1');
		expect(resources).toEqual([]);
		expect(refused[0]).toMatch(/gjelder ikke denne pasienten/);
	});

	it('refuses update and delete: a suggestion can only add', () => {
		const s: Suggestion = {
			label: 'x',
			actions: [
				{ type: 'update', resource: serviceRequest('p1', { id: 'sr-1' }) },
				{ type: 'delete', resourceId: 'ServiceRequest/sr-1' }
			]
		};
		const { resources, refused } = acceptedActions(s, 'p1');
		expect(resources).toEqual([]);
		expect(refused).toHaveLength(2);
	});

	it('refuses a create that carries an id - that would be an update wearing a hat', () => {
		const s: Suggestion = { label: 'x', actions: [{ type: 'create', resource: serviceRequest('p1', { id: 'sr-1' }) }] };
		expect(acceptedActions(s, 'p1').resources).toEqual([]);
	});

	it('takes the good actions and names the bad ones, in a mixed suggestion', () => {
		const s: Suggestion = {
			label: 'x',
			actions: [
				{ type: 'create', resource: serviceRequest('p1') },
				{ type: 'create', resource: serviceRequest('p9') }
			]
		};
		const { resources, refused } = acceptedActions(s, 'p1');
		expect(resources).toHaveLength(1);
		expect(refused).toHaveLength(1);
	});
});

/**
 * The calculators, against published worked examples.
 */
describe('calculators', () => {
	it('eGFR by CKD-EPI 2021 matches the equation', () => {
		// Worked by hand from the published equation, not remembered:
		// a 60-year-old woman at 0.9 mg/dL (79.6 µmol/L) is
		// 142 x (0.9/0.7)^-1.2 x 0.9938^60 x 1.012 = 73.2.
		expect(egfrCkdEpi2021(79.6, 60, 'female')).toBe(73);
		// A 50-year-old man at 1.0 mg/dL (88.4 µmol/L):
		// 142 x (1.0/0.9)^-1.2 x 0.9938^50 = 91.7.
		expect(egfrCkdEpi2021(88.4, 50, 'male')).toBe(92);
		// The same creatinine in an 80-year-old is a different kidney.
		expect(egfrCkdEpi2021(110, 80, 'male')).toBeLessThan(60);
	});

	it('assigns KDIGO categories at the published thresholds', () => {
		expect(gfrCategory(90).code).toBe('G1');
		expect(gfrCategory(89).code).toBe('G2');
		expect(gfrCategory(59).code).toBe('G3a');
		expect(gfrCategory(44).code).toBe('G3b');
		expect(gfrCategory(29).code).toBe('G4');
		expect(gfrCategory(14).code).toBe('G5');
	});

	it('computes BMI and its class', () => {
		expect(bmi(70, 175)).toBe(22.9);
		expect(bmiClass(22.9).code).toBe('normal');
		expect(bmiClass(31).code).toBe('fedme-1');
		expect(bmiClass(17).code).toBe('undervekt');
	});

	it('counts whole years, birthday not yet reached this year included', () => {
		expect(ageYears('1970-06-15', new Date('2026-06-14'))).toBe(55);
		expect(ageYears('1970-06-15', new Date('2026-06-15'))).toBe(56);
		expect(ageYears('not a date')).toBeNull();
	});
});

/**
 * Who is asking.
 *
 * The record signs every call to a service, and its own services refuse
 * anything else. These need the database: the keys live there.
 */
describeIf('CDS request signing', () => {
	let db: TestDatabase;
	beforeAll(async () => {
		db = await createTestDatabase('cds');
	});
	afterAll(async () => {
		await db.riv();
	});

	const eventFor = (authorization: string | null, origin = config.baseUrl): RequestEvent =>
		({
			request: new Request(`${origin}/cds-services/kritisk-informasjon`, {
				method: 'POST',
				headers: authorization ? { authorization } : {}
			}),
			url: new URL(`${origin}/cds-services/kritisk-informasjon`)
		}) as unknown as RequestEvent;

	it('signs a request the record itself will accept', async () => {
		const token = await signHookRequest(config.baseUrl);
		const caller = await requireHookCaller(eventFor(`Bearer ${token}`));
		expect(caller.iss).toBe(config.baseUrl);
		expect(caller.jti).toBeTruthy();
	});

	it('refuses a call with no signature at all', async () => {
		await expect(requireHookCaller(eventFor(null))).rejects.toBeInstanceOf(HookCallerError);
	});

	it('refuses a token meant for another service', async () => {
		const token = await signHookRequest('https://annen-tjeneste.example');
		await expect(requireHookCaller(eventFor(`Bearer ${token}`))).rejects.toMatchObject({ status: 403 });
	});

	it('refuses a token signed by someone else, however well formed', async () => {
		const { generateKeyPairSync } = await import('node:crypto');
		const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const now = Math.floor(Date.now() / 1000);
		const forged = await sign(
			{ iss: config.baseUrl, sub: config.baseUrl, aud: config.baseUrl, jti: 'x', iat: now, exp: now + 60 },
			privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
			'not-our-kid'
		);
		await expect(requireHookCaller(eventFor(`Bearer ${forged}`))).rejects.toBeInstanceOf(HookCallerError);
	});
});
