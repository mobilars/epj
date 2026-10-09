import { describe, expect, it } from 'vitest';
import {
	compactPhone,
	identityInQuery,
	isIdentityNumberShape,
	isOpenedBy,
	isPatientId,
	needsConfirmation,
	openUrlForId,
	phoneVariants,
	sourceLabel
} from '../src/lib/server/journal/openlink';

/**
 * The address another program opens to land on a patient.
 *
 * The rules worth pinning down are the ones that keep a national identity
 * number out of addresses, and the one that decides when the user is asked
 * before a record is opened in their name.
 */
describe('open-patient link', () => {
	const query = (q: string) => new URLSearchParams(q);

	it('accepts the ids the record itself issues', () => {
		expect(isPatientId('90')).toBe(true);
		expect(isPatientId('3f2b8c1e-9d4a-4c55-8b1f-0a6e2d7c9f10')).toBe(true);
		expect(isPatientId('abc.DEF-123')).toBe(true);
	});

	it('refuses anything that is not a FHIR id', () => {
		expect(isPatientId('')).toBe(false);
		expect(isPatientId('90/../91')).toBe(false);
		expect(isPatientId('90?x=1')).toBe(false);
		expect(isPatientId('a'.repeat(65))).toBe(false);
		expect(isPatientId(null)).toBe(false);
		expect(isPatientId(90)).toBe(false);
	});

	it('spots a national identity number in the query, whatever it is called', () => {
		expect(identityInQuery(query('fnr=01010112345'))).toBe(true);
		expect(identityInQuery(query('FNR=x'))).toBe(true);
		expect(identityInQuery(query('fodselsnummer=01010112345'))).toBe(true);
		expect(identityInQuery(query('personnummer=01010112345'))).toBe(true);
		expect(identityInQuery(query('identifier=urn:oid:2.16.578.1.12.4.1.4.1|01010112345'))).toBe(true);
		// Eleven digits under an innocent name is still an identity number.
		expect(identityInQuery(query('id=01010112345'))).toBe(true);
		expect(identityInQuery(query('kilde=cm&id=01010112345'))).toBe(true);
	});

	it('lets the record own ids and a source label through', () => {
		expect(identityInQuery(query('id=90'))).toBe(false);
		expect(identityInQuery(query('id=90&kilde=callmanager'))).toBe(false);
		expect(identityInQuery(query('id=3f2b8c1e-9d4a-4c55-8b1f-000000000000'))).toBe(false);
		expect(identityInQuery(query(''))).toBe(false);
	});

	it('knows the shape of an identity number without judging its checksum', () => {
		expect(isIdentityNumberShape('01010112345')).toBe(true);
		expect(isIdentityNumberShape('0101011234')).toBe(false);
		expect(isIdentityNumberShape('010101 12345')).toBe(false);
		expect(isIdentityNumberShape(undefined)).toBe(false);
	});

	it('opens straight away only for the user, a local program, or the record itself', () => {
		expect(needsConfirmation('none')).toBe(false);
		expect(needsConfirmation('same-origin')).toBe(false);
	});

	it('asks first when the link came from another site, a sibling hostname, or an unknown place', () => {
		expect(needsConfirmation('cross-site')).toBe(true);
		// Apps live on sibling hostnames. Same site is not the same origin.
		expect(needsConfirmation('same-site')).toBe(true);
		expect(needsConfirmation(null)).toBe(true);
		expect(needsConfirmation('')).toBe(true);
	});

	it('keeps only a plain label as the source, and drops the rest', () => {
		expect(sourceLabel('callmanager')).toBe('callmanager');
		expect(sourceLabel('lab-klient-2')).toBe('lab-klient-2');
		expect(sourceLabel('Call Manager')).toBeNull();
		expect(sourceLabel('<script>')).toBeNull();
		expect(sourceLabel('a'.repeat(33))).toBeNull();
		expect(sourceLabel(null)).toBeNull();
	});

	it('builds the address for a patient id', () => {
		expect(openUrlForId('90', null)).toBe('/apne/pasient?id=90');
		expect(openUrlForId('90', 'callmanager')).toBe('/apne/pasient?id=90&kilde=callmanager');
	});

	it('refuses a phone number in the query string as well', () => {
		expect(identityInQuery(query('tlf=99887766'))).toBe(true);
		expect(identityInQuery(query('telefon=%2B4799887766'))).toBe(true);
		expect(identityInQuery(query('phone=99887766'))).toBe(true);
	});
});

/**
 * A switchboard has a phone number, and the record stores numbers as they
 * were typed. The same number has to be found however either side wrote it.
 */
describe('phone lookup', () => {
	const all = ['99887766', '+4799887766', '4799887766', '004799887766', '998 87 766', '99 88 77 66', '+47 998 87 766', '+47 99 88 77 66'];

	it('spells a Norwegian number every common way, whatever form it arrives in', () => {
		for (const input of ['99887766', '+4799887766', '004799887766', '4799887766', '998 87 766', '+47 99 88 77 66', ' 99-88-77-66 ']) {
			const variants = phoneVariants(input);
			expect(variants, input).not.toBeNull();
			for (const form of all) expect(variants, `${input} -> ${form}`).toContain(form);
		}
	});

	it('gives the same set for the same number', () => {
		expect(new Set(phoneVariants('99887766'))).toEqual(new Set(phoneVariants('+47 998 87 766')));
	});

	it('searches a foreign number as it came and in compact international form', () => {
		const variants = phoneVariants('+46 70 123 45 67')!;
		expect(variants).toContain('+46701234567');
		expect(variants).toContain('0046701234567');
		// Not mistaken for a Norwegian number.
		expect(variants.some((v) => v.startsWith('+47'))).toBe(false);
	});

	it('refuses what is not a phone number', () => {
		expect(phoneVariants('anonymous')).toBeNull();
		expect(phoneVariants('')).toBeNull();
		expect(phoneVariants('123')).toBeNull();
		expect(phoneVariants('99887766,*')).toBeNull();
		expect(phoneVariants('9988 7766 x12')).toBeNull();
		expect(phoneVariants(null)).toBeNull();
		expect(phoneVariants(99887766)).toBeNull();
	});

	it('never produces a value that could break out of a search list', () => {
		for (const v of phoneVariants('+47 998 87 766')!) expect(v).toMatch(/^\+?[\d ]+$/);
	});

	it('stores a number without its spacing', () => {
		expect(compactPhone(' 998 87 766 ')).toBe('99887766');
		expect(compactPhone('+47 99-88-77-66')).toBe('+4799887766');
	});

	it('names the three ways a patient can be pointed at, and no others', () => {
		expect(isOpenedBy('id')).toBe(true);
		expect(isOpenedBy('telefon')).toBe(true);
		expect(isOpenedBy('fødselsnummer')).toBe(true);
		expect(isOpenedBy('navn')).toBe(false);
	});
});
