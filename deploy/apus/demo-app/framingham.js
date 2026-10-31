// @ts-nocheck: a plain script served to the browser as it stands.
/**
 * 10-year risk of cardiovascular disease, from the Framingham general risk profile
 * (D'Agostino et al., Circulation 2008).
 *
 * Chosen for this demo because the coefficients are published in full and the paper
 * gives worked examples to check against. Norwegian practice uses NORRISK 2, which
 * this is not, and the app says so.
 *
 * Cholesterol is in mmol/L here, as Norwegian results are. The model is in mg/dL.
 */

const MG_PER_DL_PER_MMOL = 38.67;

const COEFFICIENTS = {
	female: { age: 2.32888, total: 1.20904, hdl: -0.70833, sbp: 2.76157, sbpTreated: 2.82263, smoker: 0.52873, diabetes: 0.69154, survival: 0.95012, mean: 26.1931 },
	male: { age: 3.06117, total: 1.1237, hdl: -0.93263, sbp: 1.93303, sbpTreated: 1.99881, smoker: 0.65451, diabetes: 0.57367, survival: 0.88936, mean: 23.9802 }
};

/** The ages the model was derived on. Outside them it should not be asked. */
export const AGE_RANGE = { min: 30, max: 74 };

/**
 * @returns the risk in per cent, or null when an input is missing or outside the model.
 */
export function framinghamRisk({ sex, age, totalMmol, hdlMmol, sbp, treated = false, smoker = false, diabetes = false }) {
	const c = COEFFICIENTS[sex];
	if (!c || !(age >= AGE_RANGE.min && age <= AGE_RANGE.max) || !(totalMmol > 0) || !(hdlMmol > 0) || !(sbp > 0)) return null;
	return riskFromMgDl(c, age, totalMmol * MG_PER_DL_PER_MMOL, hdlMmol * MG_PER_DL_PER_MMOL, sbp, treated, smoker, diabetes);
}

export function riskFromMgDl(c, age, total, hdl, sbp, treated, smoker, diabetes) {
	const sum =
		c.age * Math.log(age) +
		c.total * Math.log(total) +
		c.hdl * Math.log(hdl) +
		(treated ? c.sbpTreated : c.sbp) * Math.log(sbp) +
		(smoker ? c.smoker : 0) +
		(diabetes ? c.diabetes : 0);
	return (1 - Math.pow(c.survival, Math.exp(sum - c.mean))) * 100;
}

export { COEFFICIENTS };
