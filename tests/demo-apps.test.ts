import { describe, expect, it } from 'vitest';
import { COEFFICIENTS, framinghamRisk, riskFromMgDl } from '../deploy/apus/demo-app/framingham.js';

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
