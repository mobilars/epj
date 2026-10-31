import { describe, expect, it } from 'vitest';
import { COEFFICIENTS, framinghamRisk, riskFromMgDl } from '../deploy/apus/demo-app/framingham.js';
import { exampleObservation, isExample, isTestRecord } from '../deploy/apus/demo-app/example-data.js';

describe('example data', () => {
	it('is offered only against a test environment', () => {
		expect(isTestRecord('https://epj.apps.apus.no/fhir')).toBe(true);
		expect(isTestRecord('https://prov.apps.apus.no/fhir')).toBe(true);
		expect(isTestRecord('http://localhost:5173/fhir')).toBe(true);
		expect(isTestRecord('http://127.0.0.1:4173/fhir')).toBe(true);

		expect(isTestRecord('https://journal.legekontor.no/fhir')).toBe(false);
		expect(isTestRecord('https://epj.apps.apus.no.example.com/fhir')).toBe(false);
		expect(isTestRecord('https://apps.apus.no/fhir')).toBe(false);
		expect(isTestRecord('')).toBe(false);
		expect(isTestRecord(undefined)).toBe(false);
	});

	it('says what it is, on the resource itself', () => {
		const resource = exampleObservation('p1', { code: '8480-6', display: 'Systolisk', value: 140, unit: 'mm[Hg]', when: '2026-01-01T00:00:00Z' });
		expect(isExample(resource)).toBe(true);
		expect(resource.note[0].text).toContain('Eksempeldata');
		expect(resource.subject.reference).toBe('Patient/p1');
		expect(isExample({ resourceType: 'Observation' })).toBe(false);
	});
});

describe('the heart risk demo', () => {
	// The worked examples in D'Agostino et al., Circulation 2008, in the paper's own units.
	it('matches the published example for a woman', () => {
		expect(riskFromMgDl(COEFFICIENTS.female, 61, 180, 47, 124, false, true, false)).toBeCloseTo(10.48, 1);
	});

	it('matches the published example for a man', () => {
		expect(riskFromMgDl(COEFFICIENTS.male, 53, 161, 55, 125, true, false, true)).toBeCloseTo(15.6, 0);
	});

	const person = { sex: 'male', age: 55, totalMmol: 5.5, hdlMmol: 1.3, sbp: 140 };

	it('rises with what should raise it', () => {
		const base = framinghamRisk(person) as number;
		expect(framinghamRisk({ ...person, smoker: true }) as number).toBeGreaterThan(base);
		expect(framinghamRisk({ ...person, diabetes: true }) as number).toBeGreaterThan(base);
		expect(framinghamRisk({ ...person, sbp: 170 }) as number).toBeGreaterThan(base);
		expect(framinghamRisk({ ...person, hdlMmol: 2 }) as number).toBeLessThan(base);
	});

	it('gives no answer outside the model, or with something missing', () => {
		expect(framinghamRisk({ ...person, age: 11 })).toBeNull();
		expect(framinghamRisk({ ...person, age: 80 })).toBeNull();
		expect(framinghamRisk({ ...person, sbp: 0 })).toBeNull();
		expect(framinghamRisk({ ...person, totalMmol: Number.NaN })).toBeNull();
		expect(framinghamRisk({ ...person, sex: 'unknown' })).toBeNull();
	});
});
