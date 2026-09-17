import { describe, expect, it } from 'vitest';
import { ICPC2, icpc2Chapters, isIcpc2Code, lookupIcpc2, searchIcpc2 } from '../src/lib/server/terminology/icpc2';
import { codeSystemOperation, valueSetOperation } from '../src/lib/server/terminology/operations';
import { SYSTEM } from '../src/lib/server/fhir/codesystems';

/**
 * ICPC-2 from the Directorate's own table.
 *
 * The record used to take the diagnosis code as free text; these pin down
 * that it now only files codes that exist, under their official names, and
 * that an app asking through FHIR gets the same answers.
 */
describe('ICPC-2', () => {
	it('is the complete Norwegian edition', () => {
		expect(ICPC2.url).toBe(SYSTEM.ICPC2);
		expect(icpc2Chapters().map((c) => c.code).join('')).toBe('ABDFHKLNPRSTUWXYZ');
		// 17 chapters x (symptom codes 01-29, process codes 30-69, diagnosis
		// codes 70-99) is the shape of the classification; the exact count is
		// the Directorate's, and a table a hundred short would be a bad fetch.
		expect(ICPC2.count).toBeGreaterThan(1350);
	});

	it('looks a code up under its official name, whatever the casing', () => {
		expect(lookupIcpc2(' k86 ')?.display).toBe('Hypertensjon ukomplisert');
		expect(lookupIcpc2('K86')?.icd10).toBe('I10');
		expect(lookupIcpc2('K86')?.en).toBe('Hypertension uncomplicated');
	});

	it('knows a chapter or a range from a code a diagnosis can be filed under', () => {
		expect(isIcpc2Code('K86')).toBe(true);
		expect(isIcpc2Code('K')).toBe(false);
		expect(isIcpc2Code('K70-K99')).toBe(false);
		expect(isIcpc2Code('Q99')).toBe(false);
		expect(lookupIcpc2('Q99')).toBeNull();
	});

	it('finds codes by prefix and by word, most likely first', () => {
		expect(searchIcpc2('K8').map((c) => c.code).slice(0, 3)).toEqual(['K80', 'K81', 'K82']);
		const byWord = searchIcpc2('hypertensjon').map((c) => c.code);
		expect(byWord[0]).toBe('K86');
		expect(byWord).toContain('K87');
		expect(searchIcpc2('xyzzy')).toEqual([]);
		expect(searchIcpc2('')).toEqual([]);
	});

	it('searches the inclusion notes when the name does not say it', () => {
		// K86's notes list "essensiell hypertensjon"; the name does not.
		expect(searchIcpc2('essensiell').map((c) => c.code)).toContain('K86');
	});
});

describe('terminology operations over FHIR', () => {
	const params = (system: string, code: string) => new URLSearchParams({ system, code });

	it('$lookup answers with the name, the English designation and the ICD-10 reference', () => {
		const { resource } = codeSystemOperation('$lookup', params(SYSTEM.ICPC2, 'K86'));
		const p = resource.parameter as { name: string; valueString?: string; part?: { name: string; valueCode?: string; valueString?: string }[] }[];
		expect(p.find((x) => x.name === 'display')?.valueString).toBe('Hypertensjon ukomplisert');
		const designation = p.find((x) => x.name === 'designation')?.part;
		expect(designation?.find((x) => x.name === 'value')?.valueString).toBe('Hypertension uncomplicated');
		const icd = p.filter((x) => x.name === 'property').find((x) => x.part?.some((q) => q.valueCode === 'icd-10'));
		expect(icd?.part?.find((q) => q.name === 'value')?.valueCode).toBe('I10');
	});

	it('$lookup refuses a code system it does not carry, naming the one it does', () => {
		expect(() => codeSystemOperation('$lookup', params('http://snomed.info/sct', '38341003'))).toThrow(/ICPC-2/);
	});

	it('$validate-code says yes to a code and no to a chapter', () => {
		const yes = codeSystemOperation('$validate-code', params(SYSTEM.ICPC2, 'K86')).resource.parameter as { name: string; valueBoolean?: boolean }[];
		expect(yes.find((x) => x.name === 'result')?.valueBoolean).toBe(true);
		const no = codeSystemOperation('$validate-code', params(SYSTEM.ICPC2, 'K')).resource.parameter as { name: string; valueBoolean?: boolean; valueString?: string }[];
		expect(no.find((x) => x.name === 'result')?.valueBoolean).toBe(false);
		expect(no.find((x) => x.name === 'message')?.valueString).toMatch(/kapittel/);
	});

	it('$expand filters the implicit value set by what was typed', () => {
		const { resource } = valueSetOperation('$expand', new URLSearchParams({ url: `${SYSTEM.ICPC2}?fhir_vs`, filter: 'hypertensjon', count: '5' }));
		const contains = (resource.expansion as { contains: { code: string; display: string; system: string }[] }).contains;
		expect(contains.length).toBeLessThanOrEqual(5);
		expect(contains[0]).toMatchObject({ system: SYSTEM.ICPC2, code: 'K86', display: 'Hypertensjon ukomplisert' });
	});

	it('$expand takes system= as well, since that is what people try first', () => {
		const { resource } = valueSetOperation('$expand', new URLSearchParams({ system: SYSTEM.ICPC2, filter: 'K8' }));
		const contains = (resource.expansion as { contains: { code: string }[] }).contains;
		expect(contains[0].code).toBe('K80');
	});
});
