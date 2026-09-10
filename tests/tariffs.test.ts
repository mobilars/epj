import { describe, expect, it } from 'vitest';
import {
	compute,
	COPAYMENT_ALDERSGRENSE,
	getTariff,
	oreToKroner,
	tariffAfterGroup,
	TARIFFS
} from '../src/lib/server/integrations/helfo/tariffs';

describe('takstregisteret', () => {
	it('har unike takstkoder', () => {
		const codes = TARIFFS.map((t) => t.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it('slår opp takst på kode', () => {
		expect(getTariff('2ad')?.group).toBe('konsultasjon');
		expect(getTariff('finnes-ikke')).toBeUndefined();
	});

	it('grupperer takstene', () => {
		expect(tariffAfterGroup('laboratorie').length).toBeGreaterThan(0);
	});

	it('markerer alle beløp som uverifiserte inntil de er kontrollert mot tariffen', () => {
		// This is a reminder in code: remove once the full tariff is loaded.
		expect(TARIFFS.every((t) => t.verified === false)).toBe(true);
	});
});

describe('beregning av refusjon og egenandel', () => {
	it('summerer refusjon og egenandel for en vanlig konsultasjon', () => {
		const b = compute([{ tariff_code: '2ad', count: 1 }]);
		expect(b.error).toHaveLength(0);
		expect(b.sumReimbursementOre).toBe(19_600);
		expect(b.sumCopaymentOre).toBe(24_500);
		expect(b.requiresCopaymentOre).toBe(24_500);
	});

	it('legger sammen flere takster', () => {
		const b = compute([
			{ tariff_code: '2ad', count: 1 },
			{ tariff_code: '701a', count: 2 }
		]);
		expect(b.sumReimbursementOre).toBe(19_600 + 2 * 6_100);
	});

	it('avviser takster som ikke kan kombineres', () => {
		const b = compute([
			{ tariff_code: '2ad', count: 1 },
			{ tariff_code: '1ak', count: 1 }
		]);
		expect(b.error.join(' ')).toMatch(/kan ikke kombineres/);
	});

	it('krever grunntakst for tidstillegg', () => {
		const b = compute([{ tariff_code: '2cd', count: 2 }]);
		expect(b.error.join(' ')).toMatch(/krever en av/);
	});

	it('godtar tidstillegg sammen med konsultasjon', () => {
		const b = compute([
			{ tariff_code: '2ad', count: 1 },
			{ tariff_code: '2cd', count: 2 }
		]);
		expect(b.error).toHaveLength(0);
		expect(b.sumReimbursementOre).toBe(19_600 + 2 * 14_800);
	});

	it('avviser repetisjon av takst som ikke er repeterbar', () => {
		const b = compute([{ tariff_code: '2ad', count: 3 }]);
		expect(b.error.join(' ')).toMatch(/kan ikke repeteres/);
	});

	it('håndhever maksimalt antall', () => {
		const b = compute([
			{ tariff_code: '2ad', count: 1 },
			{ tariff_code: '2cd', count: 9 }
		]);
		expect(b.error.join(' ')).toMatch(/maksimalt/);
	});

	it('krever spesialistgodkjenning for spesialisttakst', () => {
		expect(compute([{ tariff_code: '2ae', count: 1 }]).error.join(' ')).toMatch(/spesialist/);
		expect(compute([{ tariff_code: '2ae', count: 1 }], { isSpesialistAllmennmedisin: true }).error).toHaveLength(0);
	});

	it('avviser ukjent takstkode', () => {
		expect(compute([{ tariff_code: 'XYZ', count: 1 }]).error.join(' ')).toMatch(/Ukjent takstkode/);
	});

	it('varsler om uverifiserte beløp', () => {
		expect(compute([{ tariff_code: '2ad', count: 1 }]).warnings.join(' ')).toMatch(/ikke verifisert/);
	});
});

describe('fritak for egenandel', () => {
	it('gir fritak for barn under aldersgrensen', () => {
		const b = compute([{ tariff_code: '2ad', count: 1 }], { patientAge: COPAYMENT_ALDERSGRENSE - 1 });
		expect(b.exemption).toBe('barn-under-16');
		expect(b.requiresCopaymentOre).toBe(0);
		// The reimbursement from Helfo is unaffected by the exemption.
		expect(b.sumReimbursementOre).toBe(19_600);
	});

	it('krever egenandel fra og med aldersgrensen', () => {
		const b = compute([{ tariff_code: '2ad', count: 1 }], { patientAge: COPAYMENT_ALDERSGRENSE });
		expect(b.exemption).toBeNull();
		expect(b.requiresCopaymentOre).toBe(24_500);
	});

	it('gir fritak ved gyldig frikort', () => {
		const b = compute([{ tariff_code: '2ad', count: 1 }], { patientAge: 40, hasExemptionCard: true });
		expect(b.exemption).toBe('frikort');
		expect(b.requiresCopaymentOre).toBe(0);
	});

	it('lar eksplisitt fritaksgrunn gå foran alder og frikort', () => {
		const b = compute([{ tariff_code: '2ad', count: 1 }], { patientAge: 40, exemption: 'yrkesskade' });
		expect(b.exemption).toBe('yrkesskade');
		expect(b.requiresCopaymentOre).toBe(0);
	});
});

describe('beløpsformatering', () => {
	it('viser øre som kroner', () => {
		expect(oreToKroner(19_600).replace(/ /g, ' ')).toMatch(/196,00/);
	});
});
