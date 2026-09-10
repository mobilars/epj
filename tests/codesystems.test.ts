import { describe, expect, it } from 'vitest';
import {
	SYSTEM,
	isDNumber,
	validDateDel,
	validHprNumber,
	validNorwegianNationalId,
	validOrganisationNumber,
	genderFromNationalId,
	maskerNationalId
} from '../src/lib/server/fhir/codesystems';

describe('fødselsnummer', () => {
	it('godtar gyldige syntetiske fødselsnummer', () => {
		for (const fnr of ['13086510035', '05077810023', '21129410180', '24035810281', '11061550188']) {
			expect(validNorwegianNationalId(fnr), fnr).toBe(true);
		}
	});

	it('avviser feil kontrollsiffer', () => {
		expect(validNorwegianNationalId('13086510036')).toBe(false);
		expect(validNorwegianNationalId('13086510045')).toBe(false);
	});

	it('avviser feil lengde og ikke-siffer', () => {
		expect(validNorwegianNationalId('1308651003')).toBe(false);
		expect(validNorwegianNationalId('130865100355')).toBe(false);
		expect(validNorwegianNationalId('1308651003a')).toBe(false);
		expect(validNorwegianNationalId('')).toBe(false);
	});

	it('avviser ugyldig datodel', () => {
		// 32 January does not exist, whatever the check digits.
		expect(validNorwegianNationalId('32016510035')).toBe(false);
	});

	it('kjenner igjen D-nummer (dag + 40)', () => {
		expect(isDNumber('53086510035')).toBe(true);
		expect(isDNumber('13086510035')).toBe(false);
	});

	it('utleder fødselsdato med riktig århundre', () => {
		expect(validDateDel('13086510035')).toBe('1965-08-13');
		// Individual digits 501 with year 15 gives 2015, not 1915.
		expect(validDateDel('11061550188')).toBe('2015-06-11');
	});

	it('utleder kjønn fra individsifferet (partall = kvinne)', () => {
		// The individual digit is the ninth: 1 -> man, 2 -> woman.
		expect(genderFromNationalId('21129410180')).toBe('male');
		expect(genderFromNationalId('24035810281')).toBe('female');
		expect(genderFromNationalId('tull')).toBe('unknown');
	});

	it('maskerer alt annet enn fødselsdato', () => {
		expect(maskerNationalId('13086510035')).toBe('130865*****');
		expect(maskerNationalId('tull')).toBe('***');
	});
});

describe('organisasjonsnummer', () => {
	it('godtar gyldige numre', () => {
		// The Central Coordinating Register: Norsk helsenett SF and the Directorate of Health.
		expect(validOrganisationNumber('994598759')).toBe(true);
		expect(validOrganisationNumber('983544622')).toBe(true);
	});

	it('avviser feil kontrollsiffer og feil lengde', () => {
		expect(validOrganisationNumber('994598758')).toBe(false);
		expect(validOrganisationNumber('99459875')).toBe(false);
	});
});

describe('HPR-nummer', () => {
	it('godtar inntil ni siffer', () => {
		expect(validHprNumber('9144889')).toBe(true);
		expect(validHprNumber('1')).toBe(true);
		expect(validHprNumber('1234567890')).toBe(false);
		expect(validHprNumber('91a4889')).toBe(false);
	});
});

describe('kodeverkssystemer', () => {
	it('bruker OID-ene fra Volven for personidentifikatorer', () => {
		expect(SYSTEM.FNR).toBe('urn:oid:2.16.578.1.12.4.1.4.1');
		expect(SYSTEM.DNR).toBe('urn:oid:2.16.578.1.12.4.1.4.2');
		expect(SYSTEM.HPR).toBe('urn:oid:2.16.578.1.12.4.1.4.4');
	});
});
