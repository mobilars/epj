/**
 * Clinical calculations for the record's own decision support.
 *
 * Pure functions over numbers, so they can be tested against published
 * worked examples and reused by any service. Nothing here reads the record;
 * the service that calls them does, and says where each input came from.
 */

/**
 * Estimated GFR by CKD-EPI 2021, the race-free equation.
 *
 * This is the equation Norwegian laboratories report eGFR with, and the one
 * Helsedirektoratet's guidance on chronic kidney disease refers to. Creatinine
 * in µmol/L as Norwegian labs report it; the equation itself is in mg/dL, so
 * it is converted on the way in.
 *
 *   eGFR = 142 × min(Scr/κ, 1)^α × max(Scr/κ, 1)^−1.200 × 0.9938^age × 1.012 [if female]
 *   κ = 0.7 (female) / 0.9 (male), α = −0.241 (female) / −0.302 (male)
 *
 * Inker et al., NEJM 2021;385:1737-49.
 */
export function egfrCkdEpi2021(creatinineUmolL: number, ageYears: number, sex: 'male' | 'female'): number {
	const scr = creatinineUmolL / 88.4;
	const kappa = sex === 'female' ? 0.7 : 0.9;
	const alpha = sex === 'female' ? -0.241 : -0.302;
	const ratio = scr / kappa;
	const value =
		142 * Math.pow(Math.min(ratio, 1), alpha) * Math.pow(Math.max(ratio, 1), -1.2) * Math.pow(0.9938, ageYears) * (sex === 'female' ? 1.012 : 1);
	return Math.round(value);
}

/**
 * KDIGO GFR category. G3a and below is where the guidance starts to bite:
 * dose adjustments, contrast, nephrotoxic drugs, referral at G4.
 */
export function gfrCategory(egfr: number): { code: 'G1' | 'G2' | 'G3a' | 'G3b' | 'G4' | 'G5'; text: string } {
	if (egfr >= 90) return { code: 'G1', text: 'normal eller høy' };
	if (egfr >= 60) return { code: 'G2', text: 'lett nedsatt' };
	if (egfr >= 45) return { code: 'G3a', text: 'lett til moderat nedsatt' };
	if (egfr >= 30) return { code: 'G3b', text: 'moderat til alvorlig nedsatt' };
	if (egfr >= 15) return { code: 'G4', text: 'alvorlig nedsatt' };
	return { code: 'G5', text: 'nyresvikt' };
}

/** Body mass index, kg/m², to one decimal. */
export function bmi(weightKg: number, heightCm: number): number {
	const m = heightCm / 100;
	return Math.round((weightKg / (m * m)) * 10) / 10;
}

/** WHO classes, as the guidance on overweight in primary care uses them. */
export function bmiClass(value: number): { code: string; text: string } {
	if (value < 18.5) return { code: 'undervekt', text: 'undervekt' };
	if (value < 25) return { code: 'normal', text: 'normalvekt' };
	if (value < 30) return { code: 'overvekt', text: 'overvekt' };
	if (value < 35) return { code: 'fedme-1', text: 'fedme grad 1' };
	if (value < 40) return { code: 'fedme-2', text: 'fedme grad 2' };
	return { code: 'fedme-3', text: 'fedme grad 3' };
}

/** Whole years between a date of birth and today, or a reference date. */
export function ageYears(birthDate: string, at = new Date()): number | null {
	const born = new Date(birthDate);
	if (Number.isNaN(born.getTime())) return null;
	let years = at.getFullYear() - born.getFullYear();
	const beforeBirthday = at.getMonth() < born.getMonth() || (at.getMonth() === born.getMonth() && at.getDate() < born.getDate());
	if (beforeBirthday) years -= 1;
	return years;
}
