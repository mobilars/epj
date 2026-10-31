import { describe, expect, it } from 'vitest';
import { latestMeasurements } from '../src/apps/overview/server/latest-measurements';
import type { FhirResource } from '../src/platform/server/fhir/types';

const measurement = (id: string, code: string, when: string, status = 'final') =>
	({ resourceType: 'Observation', id, status, code: { coding: [{ code }] }, effectiveDateTime: when }) as FhirResource;

const ids = (list: FhirResource[]) => list.map((o) => o.id);

describe('the latest measurements', () => {
	it('orders by when it was measured, whenever it was written down', () => {
		const list = [
			{ ...measurement('old', 'a', '2024-10-31T10:00:00Z'), meta: { lastUpdated: '2026-10-31T10:00:00Z' } },
			{ ...measurement('new', 'b', '2026-10-31T10:00:00Z'), meta: { lastUpdated: '2026-01-01T10:00:00Z' } }
		] as FhirResource[];
		expect(ids(latestMeasurements(list))).toEqual(['new', 'old']);
	});

	it('shows only the newest of each kind', () => {
		const list = [
			measurement('systolic-old', '8480-6', '2025-05-01T10:00:00Z'),
			measurement('systolic-new', '8480-6', '2026-05-01T10:00:00Z'),
			measurement('weight', '29463-7', '2024-05-01T10:00:00Z')
		];
		expect(ids(latestMeasurements(list))).toEqual(['systolic-new', 'weight']);
	});

	it('tells kinds without a code apart by their text', () => {
		const list = [
			{ resourceType: 'Observation', id: 'a', status: 'final', code: { text: 'Puls' }, effectiveDateTime: '2026-01-02' },
			{ resourceType: 'Observation', id: 'b', status: 'final', code: { text: 'Vekt' }, effectiveDateTime: '2026-01-01' }
		] as FhirResource[];
		expect(ids(latestMeasurements(list))).toEqual(['a', 'b']);
	});

	it('does not let a mistake hide the value before it', () => {
		const list = [
			measurement('mistake', 'a', '2026-05-01T10:00:00Z', 'entered-in-error'),
			measurement('real', 'a', '2025-05-01T10:00:00Z')
		];
		expect(ids(latestMeasurements(list))).toEqual(['real']);
	});
});
