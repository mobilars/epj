import { describe, expect, it } from 'vitest';
import { normaliseFromR4 } from '../src/lib/server/fhir/r4';
import type { FhirResource } from '../src/lib/server/fhir/types';

/**
 * R4-shaped writes, stored as R5.
 *
 * Most apps are written against R4. The record stores R5, so the fields that
 * moved between the versions are translated on the way in. Everything R5
 * already, and every type that did not move, has to pass through untouched:
 * a translator that "fixes" an R5 resource would corrupt the writes it was
 * never meant to see.
 */
describe('R4 on write', () => {
	it('moves the R4 context backbone onto the resource', () => {
		const r4 = {
			resourceType: 'DocumentReference',
			status: 'current',
			subject: { reference: 'Patient/1' },
			context: {
				encounter: [{ reference: 'Encounter/7' }],
				period: { start: '2026-09-01' },
				facilityType: { text: 'Legekontor' },
				practiceSetting: { text: 'Allmennpraksis' },
				event: [{ text: 'EKG' }]
			}
		} as unknown as FhirResource;

		const r5 = normaliseFromR4(r4) as Record<string, unknown>;
		expect(r5.context).toEqual([{ reference: 'Encounter/7' }]);
		expect(r5.period).toEqual({ start: '2026-09-01' });
		expect(r5.facilityType).toEqual({ text: 'Legekontor' });
		expect(r5.practiceSetting).toEqual({ text: 'Allmennpraksis' });
		expect(r5.event).toEqual([{ concept: { text: 'EKG' } }]);
	});

	it('drops an R4 context that names no encounter rather than leave an R4 shape behind', () => {
		const r5 = normaliseFromR4({
			resourceType: 'DocumentReference',
			context: { period: { start: '2026-09-01' } }
		} as unknown as FhirResource) as Record<string, unknown>;
		expect(r5.context).toBeUndefined();
		expect(r5.period).toEqual({ start: '2026-09-01' });
	});

	it('turns the authenticator into an official attester', () => {
		const r5 = normaliseFromR4({
			resourceType: 'DocumentReference',
			authenticator: { reference: 'Practitioner/3' }
		} as unknown as FhirResource) as Record<string, unknown>;
		expect(r5.authenticator).toBeUndefined();
		expect(r5.attester).toEqual([
			{
				mode: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/composition-attestation-mode', code: 'official' }] },
				party: { reference: 'Practitioner/3' }
			}
		]);
	});

	it('carries content.format as a profile on the content', () => {
		const format = { system: 'urn:oid:1.3.6.1.4.1.19376.1.2.3', code: 'urn:ihe:iti:xds:2017:mimeTypeSufficient' };
		const r5 = normaliseFromR4({
			resourceType: 'DocumentReference',
			content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/9' }, format }]
		} as unknown as FhirResource) as unknown as { content: Record<string, unknown>[] };
		expect(r5.content[0].format).toBeUndefined();
		expect(r5.content[0].profile).toEqual([{ valueCoding: format }]);
		expect(r5.content[0].attachment).toEqual({ contentType: 'application/pdf', url: 'Binary/9' });
	});

	it('turns a relatesTo code into a CodeableConcept', () => {
		const r5 = normaliseFromR4({
			resourceType: 'DocumentReference',
			relatesTo: [{ code: 'replaces', target: { reference: 'DocumentReference/2' } }]
		} as unknown as FhirResource) as unknown as { relatesTo: Record<string, unknown>[] };
		expect(r5.relatesTo[0].code).toEqual({
			coding: [{ system: 'http://hl7.org/fhir/document-relationship-type', code: 'replaces' }]
		});
	});

	it('leaves an R5 DocumentReference exactly as it was', () => {
		const r5in = {
			resourceType: 'DocumentReference',
			context: [{ reference: 'Encounter/7' }],
			attester: [{ party: { reference: 'Practitioner/3' } }],
			content: [{ attachment: { url: 'Binary/9' }, profile: [{ valueUri: 'x' }] }],
			relatesTo: [{ code: { text: 'erstatter' }, target: { reference: 'DocumentReference/2' } }]
		} as unknown as FhirResource;
		expect(normaliseFromR4(r5in)).toEqual(r5in);
	});

	it('leaves types that did not move alone', () => {
		const observation = { resourceType: 'Observation', status: 'final' } as unknown as FhirResource;
		expect(normaliseFromR4(observation)).toBe(observation);
	});
});
