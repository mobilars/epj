import { describe, expect, it } from 'vitest';
import {
	SYSTEM,
	erDNummer,
	gyldigDatoDel,
	gyldigHprNummer,
	gyldigNorskPersonnummer,
	gyldigOrganisasjonsnummer,
	kjonnFraPersonnummer,
	maskerPersonnummer
} from '../src/lib/server/fhir/kodeverk';

describe('fødselsnummer', () => {
	it('godtar gyldige syntetiske fødselsnummer', () => {
		for (const fnr of ['13086510035', '05077810023', '21129410180', '24035810281', '11061550188']) {
			expect(gyldigNorskPersonnummer(fnr), fnr).toBe(true);
		}
	});

	it('avviser feil kontrollsiffer', () => {
		expect(gyldigNorskPersonnummer('13086510036')).toBe(false);
		expect(gyldigNorskPersonnummer('13086510045')).toBe(false);
	});

	it('avviser feil lengde og ikke-siffer', () => {
		expect(gyldigNorskPersonnummer('1308651003')).toBe(false);
		expect(gyldigNorskPersonnummer('130865100355')).toBe(false);
		expect(gyldigNorskPersonnummer('1308651003a')).toBe(false);
		expect(gyldigNorskPersonnummer('')).toBe(false);
	});

	it('avviser ugyldig datodel', () => {
		// 32. januar finnes ikke, uansett kontrollsiffer.
		expect(gyldigNorskPersonnummer('32016510035')).toBe(false);
	});

	it('kjenner igjen D-nummer (dag + 40)', () => {
		expect(erDNummer('53086510035')).toBe(true);
		expect(erDNummer('13086510035')).toBe(false);
	});

	it('utleder fødselsdato med riktig århundre', () => {
		expect(gyldigDatoDel('13086510035')).toBe('1965-08-13');
		// Individsiffer 501 med årstall 15 gir 2015, ikke 1915.
		expect(gyldigDatoDel('11061550188')).toBe('2015-06-11');
	});

	it('utleder kjønn fra individsifferet (partall = kvinne)', () => {
		// Individsifferet er niende siffer: 1 -> mann, 2 -> kvinne.
		expect(kjonnFraPersonnummer('21129410180')).toBe('male');
		expect(kjonnFraPersonnummer('24035810281')).toBe('female');
		expect(kjonnFraPersonnummer('tull')).toBe('unknown');
	});

	it('maskerer alt annet enn fødselsdato', () => {
		expect(maskerPersonnummer('13086510035')).toBe('130865*****');
		expect(maskerPersonnummer('tull')).toBe('***');
	});
});

describe('organisasjonsnummer', () => {
	it('godtar gyldige numre', () => {
		// Enhetsregisteret: Norsk helsenett SF og Helsedirektoratet.
		expect(gyldigOrganisasjonsnummer('994598759')).toBe(true);
		expect(gyldigOrganisasjonsnummer('983544622')).toBe(true);
	});

	it('avviser feil kontrollsiffer og feil lengde', () => {
		expect(gyldigOrganisasjonsnummer('994598758')).toBe(false);
		expect(gyldigOrganisasjonsnummer('99459875')).toBe(false);
	});
});

describe('HPR-nummer', () => {
	it('godtar inntil ni siffer', () => {
		expect(gyldigHprNummer('9144889')).toBe(true);
		expect(gyldigHprNummer('1')).toBe(true);
		expect(gyldigHprNummer('1234567890')).toBe(false);
		expect(gyldigHprNummer('91a4889')).toBe(false);
	});
});

describe('kodeverkssystemer', () => {
	it('bruker OID-ene fra Volven for personidentifikatorer', () => {
		expect(SYSTEM.FNR).toBe('urn:oid:2.16.578.1.12.4.1.4.1');
		expect(SYSTEM.DNR).toBe('urn:oid:2.16.578.1.12.4.1.4.2');
		expect(SYSTEM.HPR).toBe('urn:oid:2.16.578.1.12.4.1.4.4');
	});
});
