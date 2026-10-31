import { FhirError, issue } from '../fhir/outcome';
import type { FhirResource } from '../fhir/types';
import { ICPC2, isIcpc2Code, lookupIcpc2, searchIcpc2, type Icpc2Code } from './icpc2';

/**
 * The terminology operations, answered from the bundled tables.
 *
 * `CodeSystem/$lookup`, `CodeSystem/$validate-code` and `ValueSet/$expand` are
 * how a SMART app asks what a code means, whether it is one, and which codes
 * match what the user is typing. Answering them here means an app gets the
 * same edition of ICPC-2 the record files under, without every vendor having
 * to fetch and bundle the Directorate's tables for themselves.
 *
 * Nothing here concerns a patient, so there is no access decision and no
 * audit entry - only a signed-in caller, which the gateway has already
 * required. HAPI is not involved: the answers come from memory.
 */

const ICPC2_VALUESET = `${ICPC2.url}?fhir_vs`;

function parameters(entries: Record<string, unknown>[]): FhirResource {
	return { resourceType: 'Parameters', parameter: entries } as FhirResource;
}

function knownSystem(system: string | null): boolean {
	return system === ICPC2.url;
}

function unsupportedSystem(system: string | null): never {
	throw new FhirError(404, [
		issue('error', 'not-found', `Kodeverket ${system ?? '(mangler)'} er ikke tilgjengelig her. Tilgjengelig: ${ICPC2.url} (ICPC-2)`)
	]);
}

function lookupParameters(c: Icpc2Code): FhirResource {
	return parameters([
		{ name: 'name', valueString: ICPC2.title },
		{ name: 'version', valueString: ICPC2.version },
		{ name: 'display', valueString: c.display },
		{ name: 'designation', part: [{ name: 'language', valueCode: 'en' }, { name: 'value', valueString: c.en }] },
		...(c.chapter ? [{ name: 'property', part: [{ name: 'code', valueCode: 'chapter' }, { name: 'value', valueString: c.chapter }] }] : []),
		...(c.icd10 ? [{ name: 'property', part: [{ name: 'code', valueCode: 'icd-10' }, { name: 'value', valueCode: c.icd10 }] }] : []),
		...(c.inclusion ? [{ name: 'property', part: [{ name: 'code', valueCode: 'inclusion' }, { name: 'value', valueString: c.inclusion }] }] : []),
		...(c.exclusion ? [{ name: 'property', part: [{ name: 'code', valueCode: 'exclusion' }, { name: 'value', valueString: c.exclusion }] }] : []),
		{ name: 'property', part: [{ name: 'code', valueCode: 'inactive' }, { name: 'value', valueBoolean: !c.active }] }
	]);
}

/** `CodeSystem/$lookup` and `CodeSystem/$validate-code`. */
export function codeSystemOperation(operation: string, search: URLSearchParams): { status: number; resource: FhirResource } {
	const system = search.get('system');
	const code = search.get('code');

	if (operation === '$lookup') {
		if (!knownSystem(system)) unsupportedSystem(system);
		if (!code) throw FhirError.invalid('$lookup trenger parameteren code');
		const found = lookupIcpc2(code);
		if (!found) throw new FhirError(404, [issue('error', 'not-found', `Koden ${code} finnes ikke i ICPC-2`)]);
		return { status: 200, resource: lookupParameters(found) };
	}

	if (operation === '$validate-code') {
		if (!knownSystem(system)) unsupportedSystem(system);
		if (!code) throw FhirError.invalid('$validate-code trenger parameteren code');
		const found = lookupIcpc2(code);
		const valid = isIcpc2Code(code);
		return {
			status: 200,
			resource: parameters([
				{ name: 'result', valueBoolean: valid },
				...(found ? [{ name: 'display', valueString: found.display }] : []),
				...(!valid
					? [{ name: 'message', valueString: found ? `${code} er et kapittel eller en gruppe, ikke en kode en diagnose kan føres på` : `Koden ${code} finnes ikke i ICPC-2` }]
					: [])
			])
		};
	}

	throw FhirError.notStottet(`Operasjonen ${operation} på CodeSystem er ikke tilgjengelig`);
}

/**
 * `ValueSet/$expand` over the implicit value set of a code system.
 *
 * `url=<system>?fhir_vs` is the standard spelling; `system=<system>` is
 * accepted too, because that is what people try first. `filter` is what the
 * user has typed, and `count` how many to return.
 */
export function valueSetOperation(operation: string, search: URLSearchParams): { status: number; resource: FhirResource } {
	if (operation !== '$expand') throw FhirError.notStottet(`Operasjonen ${operation} på ValueSet er ikke tilgjengelig`);

	const url = search.get('url');
	const system = url ? url.replace(/\?fhir_vs$/, '') : search.get('system');
	if (!knownSystem(system)) unsupportedSystem(system);

	const filter = search.get('filter') ?? '';
	const count = Math.min(Math.max(Number(search.get('count') ?? 20) || 20, 1), 200);
	const matches = filter ? searchIcpc2(filter, count) : [];

	return {
		status: 200,
		resource: {
			resourceType: 'ValueSet',
			url: ICPC2_VALUESET,
			version: ICPC2.version,
			name: 'ICPC2',
			title: ICPC2.title,
			status: 'active',
			compose: { include: [{ system: ICPC2.url }] },
			expansion: {
				identifier: `urn:uuid:${crypto.randomUUID()}`,
				timestamp: new Date().toISOString(),
				total: matches.length,
				parameter: [
					{ name: 'filter', valueString: filter },
					{ name: 'count', valueInteger: count }
				],
				contains: matches.map((c) => ({
					system: ICPC2.url,
					version: ICPC2.version,
					code: c.code,
					display: c.display,
					designation: [{ language: 'en', value: c.en }]
				}))
			}
		} as FhirResource
	};
}

/** The CodeSystem resource itself, for `GET CodeSystem?url=` and the capability statement. */
export function icpc2CodeSystemResource(): FhirResource {
	return {
		resourceType: 'CodeSystem',
		id: 'icpc-2',
		url: ICPC2.url,
		version: ICPC2.version,
		name: 'ICPC2',
		title: ICPC2.title,
		status: 'active',
		publisher: 'Helsedirektoratet',
		description: `${ICPC2.source}. ${ICPC2.count} koder.`,
		content: 'complete',
		count: ICPC2.count,
		property: [
			{ code: 'chapter', type: 'string' },
			{ code: 'icd-10', type: 'code', description: 'Hovedreferanse til ICD-10' },
			{ code: 'inclusion', type: 'string' },
			{ code: 'exclusion', type: 'string' },
			{ code: 'inactive', type: 'boolean' }
		]
	} as FhirResource;
}
