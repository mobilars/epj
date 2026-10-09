import { describe, expect, it } from 'vitest';
import {
	applyDetails,
	changedFields,
	detailsOf,
	detailsProblem,
	identifierFor,
	identitySearch,
	nationalIdOf,
	type PatientDetails
} from '../src/lib/server/journal/patientdetails';
import { SYSTEM, validNorwegianNationalId } from '../src/lib/server/fhir/codesystems';
import { toPatientDisplay } from '../src/lib/server/fhir/display';
import type { FhirResource } from '../src/lib/server/fhir/types';

/** A number with correct check digits, built rather than remembered. */
function validNumber(): string {
	for (let individual = 100; individual < 500; individual++) {
		for (let k1 = 0; k1 < 10; k1++) {
			for (let k2 = 0; k2 < 10; k2++) {
				const n = `010190${individual}${k1}${k2}`;
				if (validNorwegianNationalId(n)) return n;
			}
		}
	}
	throw new Error('no valid number found');
}

const REAL = validNumber();
/** The same number with its last check digit moved on by one. */
const FAKE = REAL.slice(0, 10) + String((Number(REAL[10]) + 1) % 10);

const details = (over: Partial<PatientDetails> = {}): PatientDetails => ({
	nationalId: REAL,
	given: 'Anne',
	family: 'Bakken',
	birthDate: '',
	gender: '',
	phone: '',
	email: '',
	addressLine: '',
	postalCode: '',
	city: '',
	...over
});

describe('patient details', () => {
	it('has a real and a fake number to test with', () => {
		expect(validNorwegianNationalId(REAL)).toBe(true);
		expect(validNorwegianNationalId(FAKE)).toBe(false);
		expect(FAKE).toMatch(/^\d{11}$/);
	});

	it('accepts a complete entry with a real number', () => {
		expect(detailsProblem(details(), false)).toBeNull();
	});

	it('warns about a number that fails its check, and saves once the user has confirmed', () => {
		const problem = detailsProblem(details({ nationalId: FAKE }), false);
		expect(problem?.kind).toBe('confirm-identity');
		expect(detailsProblem(details({ nationalId: FAKE }), true)).toBeNull();
	});

	it('still refuses what is not eleven digits, confirmed or not', () => {
		for (const nationalId of ['', '123', '0101901234', '010190123456', '0101901234a']) {
			expect(detailsProblem(details({ nationalId }), true)?.kind, nationalId).toBe('error');
		}
	});

	it('refuses a missing name, an impossible or future date, a bad email and a bad postcode', () => {
		expect(detailsProblem(details({ given: '' }), false)?.kind).toBe('error');
		expect(detailsProblem(details({ family: '' }), false)?.kind).toBe('error');
		expect(detailsProblem(details({ birthDate: '1990-02-30' }), false)?.kind).toBe('error');
		expect(detailsProblem(details({ birthDate: '2999-01-01' }), false)?.kind).toBe('error');
		expect(detailsProblem(details({ email: 'anne' }), false)?.kind).toBe('error');
		expect(detailsProblem(details({ postalCode: '123' }), false)?.kind).toBe('error');
	});

	it('files a real number under the national system and a fake one under the record own', () => {
		expect(identifierFor(REAL)).toEqual({ system: SYSTEM.FNR, value: REAL, use: 'official' });
		expect(identifierFor(FAKE)).toEqual({ system: SYSTEM.UNVERIFIED_NATIONAL_ID, value: FAKE, use: 'temp' });
	});

	it('searches for a number under every system it could be filed under', () => {
		const search = identitySearch(FAKE);
		for (const system of [SYSTEM.FNR, SYSTEM.DNR, SYSTEM.UNVERIFIED_NATIONAL_ID]) {
			expect(search).toContain(`${system}|${FAKE}`);
		}
	});
});

describe('writing details onto a patient', () => {
	const existing = {
		resourceType: 'Patient',
		id: '90',
		meta: { versionId: '3' },
		identifier: [
			{ system: SYSTEM.FNR, value: REAL, use: 'official' },
			{ system: 'urn:other:local-id', value: 'L-17' }
		],
		name: [
			{ use: 'official', family: 'Bakken', given: ['Anne'] },
			{ use: 'maiden', family: 'Lie' }
		],
		gender: 'female',
		birthDate: '1990-01-01',
		telecom: [
			{ system: 'phone', value: '99887766', use: 'mobile' },
			{ system: 'phone', value: '22334455', use: 'work' },
			{ system: 'email', value: 'anne@example.org' }
		],
		address: [
			{ use: 'home', line: ['Storgata 1'], postalCode: '0155', city: 'Oslo', country: 'NO' },
			{ use: 'work', city: 'Bergen' }
		],
		generalPractitioner: [{ reference: 'Practitioner/7', display: 'Dr. Fastlege' }],
		extension: [{ url: 'urn:x', valueString: 'kept' }]
	} as unknown as FhirResource;

	type Loose = Record<string, any>;

	it('reads the details back as the form shows them', () => {
		expect(detailsOf(existing)).toMatchObject({
			nationalId: REAL,
			given: 'Anne',
			family: 'Bakken',
			birthDate: '1990-01-01',
			gender: 'female',
			phone: '99887766',
			email: 'anne@example.org',
			addressLine: 'Storgata 1',
			postalCode: '0155',
			city: 'Oslo'
		});
	});

	it('changes what the form covers and leaves everything else alone', () => {
		const out = applyDetails(existing, {
			...detailsOf(existing),
			family: 'Bakken-Lie',
			phone: '+47 911 22 333',
			city: 'Bærum'
		}) as Loose;
		expect(out.name[0]).toMatchObject({ use: 'official', family: 'Bakken-Lie', given: ['Anne'] });
		expect(out.name[1]).toEqual({ use: 'maiden', family: 'Lie' });
		expect(out.telecom[0]).toEqual({ system: 'phone', value: '+4791122333', use: 'mobile' });
		expect(out.telecom[1]).toEqual({ system: 'phone', value: '22334455', use: 'work' });
		expect(out.address[0]).toMatchObject({ line: ['Storgata 1'], postalCode: '0155', city: 'Bærum', use: 'home', country: 'NO' });
		expect(out.address[1]).toEqual({ use: 'work', city: 'Bergen' });
		expect(out.identifier).toContainEqual({ system: 'urn:other:local-id', value: 'L-17' });
		expect(out.generalPractitioner).toEqual((existing as Loose).generalPractitioner);
		expect(out.extension).toEqual((existing as Loose).extension);
		expect(out.id).toBe('90');
		expect(out.meta).toEqual({ versionId: '3' });
	});

	it('does not alter the resource it was given', () => {
		const before = JSON.stringify(existing);
		applyDetails(existing, { ...detailsOf(existing), family: 'Annet', phone: '', city: '' });
		expect(JSON.stringify(existing)).toBe(before);
	});

	it('removes a phone, an email or an address that was cleared, and only that one', () => {
		const out = applyDetails(existing, {
			...detailsOf(existing),
			phone: '',
			email: '',
			addressLine: '',
			postalCode: '',
			city: ''
		}) as Loose;
		expect(out.telecom).toEqual([{ system: 'phone', value: '22334455', use: 'work' }]);
		expect(out.address).toEqual([{ use: 'work', city: 'Bergen' }]);
	});

	it('swaps a real number for a fake one without leaving the real one behind', () => {
		const out = applyDetails(existing, { ...detailsOf(existing), nationalId: FAKE }) as Loose;
		expect(out.identifier.filter((i: Loose) => i.system === SYSTEM.FNR)).toEqual([]);
		expect(nationalIdOf(out as FhirResource)).toBe(FAKE);
		// A fake number says nothing about birth date or gender: they stay.
		expect(out.birthDate).toBe('1990-01-01');
		expect(out.gender).toBe('female');
	});

	it('takes birth date and gender from the form when they are given', () => {
		const out = applyDetails(existing, {
			...detailsOf(existing),
			nationalId: FAKE,
			birthDate: '1985-06-15',
			gender: 'male'
		}) as Loose;
		expect(out.birthDate).toBe('1985-06-15');
		expect(out.gender).toBe('male');
	});

	it('builds a new patient from nothing', () => {
		const out = applyDetails(
			{ resourceType: 'Patient' } as FhirResource,
			details({ phone: '998 87 766', addressLine: 'Veien 2', postalCode: '1234', city: 'Sted' })
		) as Loose;
		expect(out.identifier).toEqual([{ system: SYSTEM.FNR, value: REAL, use: 'official' }]);
		expect(out.name).toEqual([{ use: 'official', family: 'Bakken', given: ['Anne'] }]);
		expect(out.birthDate).toBe('1990-01-01');
		expect(out.telecom).toEqual([{ system: 'phone', value: '99887766', use: 'mobile' }]);
		expect(out.address).toEqual([{ use: 'home', country: 'NO', line: ['Veien 2'], postalCode: '1234', city: 'Sted' }]);
	});

	it('names what changed without saying what it changed to', () => {
		const before = detailsOf(existing);
		expect(changedFields(before, { ...before, family: 'Ny', phone: '998 87 766' })).toEqual(['etternavn']);
		expect(changedFields(before, { ...before, phone: '91122333' })).toEqual(['telefon']);
		expect(changedFields(before, { ...before, birthDate: '', gender: '' })).toEqual([]);
		expect(changedFields(before, before)).toEqual([]);
	});
});

describe('showing a patient with an unverified number', () => {
	const patient = (system: string, value: string) =>
		toPatientDisplay({
			resourceType: 'Patient',
			id: '1',
			identifier: [{ system, value }],
			name: [{ family: 'Test' }]
		} as unknown as FhirResource);

	it('never hands the unverified number out as a national identity number', () => {
		const shown = patient(SYSTEM.UNVERIFIED_NATIONAL_ID, FAKE);
		// Messages, claims and printouts read this field.
		expect(shown.nationalId).toBeNull();
		expect(shown.nationalIdUnverified).toBe(true);
		expect(shown.nationalIdMasked).not.toBeNull();
		expect(shown.nationalIdMasked).not.toContain(FAKE.slice(6));
	});

	it('shows a real number as before', () => {
		const shown = patient(SYSTEM.FNR, REAL);
		expect(shown.nationalId).toBe(REAL);
		expect(shown.nationalIdUnverified).toBe(false);
	});
});
