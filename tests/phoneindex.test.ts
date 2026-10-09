import { describe, expect, it } from 'vitest';
import { addPatient, lookupKey, phoneKeys } from '../src/lib/server/journal/phoneindex';

/**
 * Phone numbers compared by what they are, not by how they were typed.
 *
 * The record stores a number as someone wrote it, and a caller's exchange
 * sends it as it pleases. Both are reduced to digits with a country code, and
 * the tests below are the spellings that have to land on the same number.
 */
describe('phone numbers as comparable numbers', () => {
	const same = [
		'99887766',
		'998 87 766',
		'99 88 77 66',
		'99 887 766',
		'9988 7766',
		'998-87-766',
		'998.87.766',
		'+4799887766',
		'+47 99887766',
		'+47 99 88 77 66',
		'+47 998 87 766',
		'+47-998-87-766',
		'(+47) 998 87 766',
		'004799887766',
		'0047 99 88 77 66',
		'4799887766',
		'47 99 88 77 66',
		' 99887766 ',
		'99 88 77 66',
		'tlf 99887766',
		'99887766 (mor)',
		'Mobil: +47 998 87 766'
	];

	it('reduces every spelling of a Norwegian number to the same value', () => {
		for (const spelling of same) expect(phoneKeys(spelling), spelling).toEqual(['4799887766']);
	});

	it('reads a caller number the same way, with tel: in front or not', () => {
		for (const spelling of same.slice(0, 19)) expect(lookupKey(spelling), spelling).toBe('4799887766');
		expect(lookupKey('tel:+4799887766')).toBe('4799887766');
		expect(lookupKey('TEL:99887766')).toBe('4799887766');
	});

	it('keeps a foreign number apart from a Norwegian one with the same digits', () => {
		expect(phoneKeys('+46 70 123 45 67')).toEqual(['46701234567']);
		expect(phoneKeys('0046 70 123 45 67')).toEqual(['46701234567']);
		expect(phoneKeys('+46 99887766')).toEqual(['4699887766']);
		expect(phoneKeys('+46 99887766')).not.toEqual(phoneKeys('99887766'));
	});

	it('finds both numbers when two share a field', () => {
		expect(phoneKeys('99887766 / 22334455').sort()).toEqual(['4722334455', '4799887766']);
		expect(phoneKeys('99887766, 22 33 44 55').sort()).toEqual(['4722334455', '4799887766']);
		expect(phoneKeys('99887766 22334455').sort()).toEqual(['4722334455', '4799887766']);
		expect(phoneKeys('99887766 (mor) eller 22334455 (far)').sort()).toEqual(['4722334455', '4799887766']);
	});

	it('gives nothing for what is not a phone number', () => {
		expect(phoneKeys('')).toEqual([]);
		expect(phoneKeys('ukjent')).toEqual([]);
		expect(phoneKeys('123')).toEqual([]);
		expect(phoneKeys(null)).toEqual([]);
		expect(phoneKeys(99887766)).toEqual([]);
	});

	it('refuses a caller number that is hidden, an extension, or more than one number', () => {
		expect(lookupKey('anonymous')).toBeNull();
		expect(lookupKey('')).toBeNull();
		expect(lookupKey('Unknown')).toBeNull();
		expect(lookupKey('214')).toBeNull();
		expect(lookupKey('99887766 / 22334455')).toBeNull();
		expect(lookupKey('9'.repeat(80))).toBeNull();
		expect(lookupKey(undefined)).toBeNull();
	});

	it('produces only digits, so a value can never alter a search', () => {
		for (const input of ['99887766,*', '+47 998|87 766', "99887766' OR 1=1", '99887766&_count=1000']) {
			for (const key of phoneKeys(input)) expect(key).toMatch(/^\d{5,15}$/);
		}
	});
});

describe('the lookup table', () => {
	it('files a patient under every number they have, however each was written', () => {
		const table = new Map<string, Set<string>>();
		addPatient(table, 'a', [{ system: 'phone', value: '998 87 766' }, { system: 'phone', value: '+47 22 33 44 55' }]);
		addPatient(table, 'b', [{ system: 'phone', value: '+4799887766' }]);
		expect([...table.get('4799887766')!].sort()).toEqual(['a', 'b']);
		expect([...table.get('4722334455')!]).toEqual(['a']);
	});

	it('finds a household on one number', () => {
		const table = new Map<string, Set<string>>();
		addPatient(table, 'mor', [{ system: 'phone', value: '99887766' }]);
		addPatient(table, 'barn1', [{ system: 'phone', value: '99 88 77 66 (mor)' }]);
		addPatient(table, 'barn2', [{ system: 'sms', value: '+47 998 87 766' }]);
		expect(table.get(lookupKey('0047 998 87 766')!)!.size).toBe(3);
	});

	it('ignores email, addresses on the web, and missing or malformed contact points', () => {
		const table = new Map<string, Set<string>>();
		addPatient(table, 'a', [{ system: 'email', value: 'a99887766@example.org' }, { system: 'url', value: 'https://x/99887766' }]);
		addPatient(table, 'b', undefined);
		addPatient(table, 'c', [null, {}, { system: 'phone' }]);
		expect(table.size).toBe(0);
	});

	it('counts a contact point with no system as a phone number', () => {
		const table = new Map<string, Set<string>>();
		addPatient(table, 'a', [{ value: '99887766' }]);
		expect(table.get('4799887766')?.has('a')).toBe(true);
	});
});
