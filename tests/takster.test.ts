import { describe, expect, it } from 'vitest';
import {
	beregn,
	EGENANDEL_ALDERSGRENSE,
	hentTakst,
	oreTilKroner,
	takstEtterGruppe,
	TAKSTER
} from '../src/lib/server/integrasjoner/helfo/takster';

describe('takstregisteret', () => {
	it('har unike takstkoder', () => {
		const koder = TAKSTER.map((t) => t.kode);
		expect(new Set(koder).size).toBe(koder.length);
	});

	it('slår opp takst på kode', () => {
		expect(hentTakst('2ad')?.gruppe).toBe('konsultasjon');
		expect(hentTakst('finnes-ikke')).toBeUndefined();
	});

	it('grupperer takstene', () => {
		expect(takstEtterGruppe('laboratorie').length).toBeGreaterThan(0);
	});

	it('markerer alle beløp som uverifiserte inntil de er kontrollert mot tariffen', () => {
		// Dette er en påminnelse i kode: fjern når normaltariffen er lagt inn.
		expect(TAKSTER.every((t) => t.verifisert === false)).toBe(true);
	});
});

describe('beregning av refusjon og egenandel', () => {
	it('summerer refusjon og egenandel for en vanlig konsultasjon', () => {
		const b = beregn([{ takstkode: '2ad', antall: 1 }]);
		expect(b.feil).toHaveLength(0);
		expect(b.sumRefusjonOre).toBe(19_600);
		expect(b.sumEgenandelOre).toBe(24_500);
		expect(b.kreverEgenandelOre).toBe(24_500);
	});

	it('legger sammen flere takster', () => {
		const b = beregn([
			{ takstkode: '2ad', antall: 1 },
			{ takstkode: '701a', antall: 2 }
		]);
		expect(b.sumRefusjonOre).toBe(19_600 + 2 * 6_100);
	});

	it('avviser takster som ikke kan kombineres', () => {
		const b = beregn([
			{ takstkode: '2ad', antall: 1 },
			{ takstkode: '1ak', antall: 1 }
		]);
		expect(b.feil.join(' ')).toMatch(/kan ikke kombineres/);
	});

	it('krever grunntakst for tidstillegg', () => {
		const b = beregn([{ takstkode: '2cd', antall: 2 }]);
		expect(b.feil.join(' ')).toMatch(/krever en av/);
	});

	it('godtar tidstillegg sammen med konsultasjon', () => {
		const b = beregn([
			{ takstkode: '2ad', antall: 1 },
			{ takstkode: '2cd', antall: 2 }
		]);
		expect(b.feil).toHaveLength(0);
		expect(b.sumRefusjonOre).toBe(19_600 + 2 * 14_800);
	});

	it('avviser repetisjon av takst som ikke er repeterbar', () => {
		const b = beregn([{ takstkode: '2ad', antall: 3 }]);
		expect(b.feil.join(' ')).toMatch(/kan ikke repeteres/);
	});

	it('håndhever maksimalt antall', () => {
		const b = beregn([
			{ takstkode: '2ad', antall: 1 },
			{ takstkode: '2cd', antall: 9 }
		]);
		expect(b.feil.join(' ')).toMatch(/maksimalt/);
	});

	it('krever spesialistgodkjenning for spesialisttakst', () => {
		expect(beregn([{ takstkode: '2ae', antall: 1 }]).feil.join(' ')).toMatch(/spesialist/);
		expect(beregn([{ takstkode: '2ae', antall: 1 }], { erSpesialistAllmennmedisin: true }).feil).toHaveLength(0);
	});

	it('avviser ukjent takstkode', () => {
		expect(beregn([{ takstkode: 'XYZ', antall: 1 }]).feil.join(' ')).toMatch(/Ukjent takstkode/);
	});

	it('varsler om uverifiserte beløp', () => {
		expect(beregn([{ takstkode: '2ad', antall: 1 }]).advarsler.join(' ')).toMatch(/ikke verifisert/);
	});
});

describe('fritak for egenandel', () => {
	it('gir fritak for barn under aldersgrensen', () => {
		const b = beregn([{ takstkode: '2ad', antall: 1 }], { pasientAlder: EGENANDEL_ALDERSGRENSE - 1 });
		expect(b.fritak).toBe('barn-under-16');
		expect(b.kreverEgenandelOre).toBe(0);
		// Refusjonen fra Helfo påvirkes ikke av fritaket.
		expect(b.sumRefusjonOre).toBe(19_600);
	});

	it('krever egenandel fra og med aldersgrensen', () => {
		const b = beregn([{ takstkode: '2ad', antall: 1 }], { pasientAlder: EGENANDEL_ALDERSGRENSE });
		expect(b.fritak).toBeNull();
		expect(b.kreverEgenandelOre).toBe(24_500);
	});

	it('gir fritak ved gyldig frikort', () => {
		const b = beregn([{ takstkode: '2ad', antall: 1 }], { pasientAlder: 40, harFrikort: true });
		expect(b.fritak).toBe('frikort');
		expect(b.kreverEgenandelOre).toBe(0);
	});

	it('lar eksplisitt fritaksgrunn gå foran alder og frikort', () => {
		const b = beregn([{ takstkode: '2ad', antall: 1 }], { pasientAlder: 40, fritak: 'yrkesskade' });
		expect(b.fritak).toBe('yrkesskade');
		expect(b.kreverEgenandelOre).toBe(0);
	});
});

describe('beløpsformatering', () => {
	it('viser øre som kroner', () => {
		expect(oreTilKroner(19_600).replace(/ /g, ' ')).toMatch(/196,00/);
	});
});
