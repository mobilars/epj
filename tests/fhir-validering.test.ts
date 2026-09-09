import { describe, expect, it } from 'vitest';
import { valider, validerEllerKast } from '../src/lib/server/fhir/validate';
import { SYSTEM } from '../src/lib/server/fhir/kodeverk';
import { datoIntervall, hentVerdier, normaliserTekst, parseReferanse, utvidDato } from '../src/lib/server/fhir/fhirpath';
import { PASIENTKOMPARTMENT } from '../src/lib/server/fhir/searchparams';
import { FhirError } from '../src/lib/server/fhir/outcome';

const feil = (r: unknown, type?: string) => valider(r, type).filter((i) => i.severity === 'error' || i.severity === 'fatal');

describe('strukturell validering', () => {
	it('godtar en gyldig pasient', () => {
		expect(
			feil({
				resourceType: 'Patient',
				identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
				name: [{ family: 'Bakken', given: ['Anne'] }]
			}, 'Patient')
		).toHaveLength(0);
	});

	it('krever resourceType', () => {
		expect(feil({ name: [] })[0].diagnostics).toMatch(/resourceType/);
	});

	it('avviser feil ressurstype mot forventet', () => {
		expect(feil({ resourceType: 'Observation', status: 'final', code: {}, subject: {} }, 'Patient').some((f) => f.diagnostics?.includes('Forventet Patient'))).toBe(true);
	});

	it('avviser ustøttet ressurstype', () => {
		expect(feil({ resourceType: 'Ingredient' }).some((f) => f.code === 'not-supported')).toBe(true);
	});

	it('avviser ugyldig logisk id', () => {
		expect(feil({ resourceType: 'Patient', id: 'har mellomrom' }, 'Patient').some((f) => f.diagnostics?.includes('logisk id'))).toBe(true);
		expect(feil({ resourceType: 'Patient', id: 'a'.repeat(65) }, 'Patient')).toHaveLength(1);
	});
});

describe('norske identifikatorer', () => {
	it('avviser fødselsnummer med feil kontrollsiffer', () => {
		const f = feil({ resourceType: 'Patient', identifier: [{ system: SYSTEM.FNR, value: '13086510036' }] }, 'Patient');
		expect(f[0].diagnostics).toMatch(/mod11/);
	});

	it('avviser ugyldig organisasjonsnummer', () => {
		const f = feil({ resourceType: 'Organization', identifier: [{ system: SYSTEM.ORGNR, value: '123456789' }] }, 'Organization');
		expect(f[0].diagnostics).toMatch(/organisasjonsnummer/i);
	});

	it('godtar gyldig HPR-nummer', () => {
		expect(feil({ resourceType: 'Practitioner', identifier: [{ system: SYSTEM.HPR, value: '9144889' }] }, 'Practitioner')).toHaveLength(0);
	});

	it('krever verdi i Identifier', () => {
		expect(feil({ resourceType: 'Patient', identifier: [{ system: SYSTEM.FNR }] }, 'Patient')[0].code).toBe('required');
	});
});

describe('obligatoriske felt og kodede statuser', () => {
	it('krever status, kode og subjekt på Observation', () => {
		const f = feil({ resourceType: 'Observation' }, 'Observation');
		expect(f.map((x) => x.diagnostics).join(' ')).toMatch(/status/);
		expect(f.map((x) => x.diagnostics).join(' ')).toMatch(/code/);
		expect(f.map((x) => x.diagnostics).join(' ')).toMatch(/subject/);
	});

	it('avviser ugyldig statuskode', () => {
		const f = feil({ resourceType: 'Observation', status: 'ferdig', code: {}, subject: { reference: 'Patient/1' } }, 'Observation');
		expect(f.some((x) => x.code === 'code-invalid')).toBe(true);
	});

	it('godtar gyldig MedicationRequest', () => {
		expect(
			feil({
				resourceType: 'MedicationRequest',
				status: 'active',
				intent: 'order',
				subject: { reference: 'Patient/1' }
			}, 'MedicationRequest')
		).toHaveLength(0);
	});
});

describe('referanser', () => {
	it('godtar relative, absolutte og uuid-referanser', () => {
		expect(feil({ resourceType: 'Observation', status: 'final', code: {}, subject: { reference: 'Patient/abc' } }, 'Observation')).toHaveLength(0);
		expect(feil({ resourceType: 'Observation', status: 'final', code: {}, subject: { reference: 'urn:uuid:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' } }, 'Observation')).toHaveLength(0);
	});

	it('avviser tull i referansen', () => {
		const f = feil({ resourceType: 'Observation', status: 'final', code: {}, subject: { reference: 'ikke en referanse' } }, 'Observation');
		expect(f.some((x) => x.diagnostics?.includes('Ugyldig referanse'))).toBe(true);
	});
});

describe('validerEllerKast', () => {
	it('kaster FhirError med status 422', () => {
		try {
			validerEllerKast({ resourceType: 'Observation' }, 'Observation');
			throw new Error('skulle kastet');
		} catch (err) {
			expect(err).toBeInstanceOf(FhirError);
			expect((err as FhirError).status).toBe(422);
		}
	});

	it('slipper gyldig ressurs gjennom', () => {
		const r = validerEllerKast({ resourceType: 'Patient', name: [{ family: 'Vik' }] }, 'Patient');
		expect(r.resourceType).toBe('Patient');
	});
});

describe('FHIR-stier', () => {
	it('henter verdier gjennom arrays', () => {
		const r = { name: [{ given: ['Anne', 'Marie'], family: 'Bakken' }, { given: ['A'], family: 'B' }] };
		expect(hentVerdier(r, 'name.given')).toEqual(['Anne', 'Marie', 'A']);
		expect(hentVerdier(r, 'name.family')).toEqual(['Bakken', 'B']);
		expect(hentVerdier(r, 'finnes.ikke')).toEqual([]);
	});

	it('tolker referanser', () => {
		expect(parseReferanse({ reference: 'Patient/123' })).toEqual({ type: 'Patient', id: '123' });
		expect(parseReferanse('Observation/9/_history/2')).toEqual({ type: 'Observation', id: '9' });
		expect(parseReferanse('urn:uuid:abc')).toEqual({ type: null, id: 'abc' });
		expect(parseReferanse(null)).toBeNull();
	});

	it('utvider ufullstendige datoer', () => {
		expect(utvidDato('2026', 'lav')).toBe('2026-01-01T00:00:00.000Z');
		expect(utvidDato('2026', 'hoy')).toBe('2026-12-31T23:59:59.999Z');
		expect(utvidDato('2026-02', 'hoy')).toBe('2026-02-28T23:59:59.999Z');
		expect(utvidDato('2024-02', 'hoy')).toBe('2024-02-29T23:59:59.999Z');
	});

	it('lager intervall av perioder', () => {
		const iv = datoIntervall({ start: '2026-01-01', end: '2026-01-31' });
		expect(iv?.lav).toBe('2026-01-01T00:00:00.000Z');
		expect(iv?.hoy).toBe('2026-01-31T23:59:59.999Z');
	});

	it('folder norske bokstaver konsistent', () => {
		expect(normaliserTekst('Søren Ødegård')).toBe('soren odegard');
		expect(normaliserTekst('  ÆRE  ')).toBe('aere');
		expect(normaliserTekst('Håkon')).toBe('hakon');
		// Alle tre bokstavene behandles likt - ingen halvveis folding.
		expect(normaliserTekst('æøå')).toBe('aeoa');
	});
});

describe('pasientkompartment', () => {
	it('kjenner pasientreferansen for kliniske ressurstyper', () => {
		expect(PASIENTKOMPARTMENT.Observation).toContain('subject');
		expect(PASIENTKOMPARTMENT.AllergyIntolerance).toContain('patient');
		expect(PASIENTKOMPARTMENT.Coverage).toContain('beneficiary');
	});

	it('utelater ressurstyper uten pasient', () => {
		expect(PASIENTKOMPARTMENT.Organization).toBeUndefined();
		expect(PASIENTKOMPARTMENT.Practitioner).toBeUndefined();
	});
});
