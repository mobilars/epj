import { afterEach, describe, expect, it, vi } from 'vitest';
import { fhirClient } from '../src/platform/server/fhir/client';
import { withTenant, type Tenant } from '../src/platform/server/tenant/context';

/**
 * HAPI answers a search it has seen in the last minute from a cache, so someone who
 * saves something and looks again would not see it. Found on the real server: the test
 * double used by the browser tests has no such cache, so this is checked here.
 */
describe('what the record asks of the FHIR server', () => {
	afterEach(() => vi.unstubAllGlobals());

	const tenant = { id: 'standard' } as Tenant;

	function capture() {
		const headers: Record<string, string>[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				headers.push(init.headers as Record<string, string>);
				return new Response('{"resourceType":"Bundle"}', { status: 200, headers: { 'content-type': 'application/fhir+json' } });
			})
		);
		return headers;
	}

	it('asks that a search is not answered from a cache', async () => {
		const headers = capture();
		await withTenant(tenant, () => fhirClient.search('Observation', new URLSearchParams({ patient: 'p1' })));
		expect(headers[0]['cache-control']).toBe('no-cache');
	});

	it('asks the same of the whole record', async () => {
		const headers = capture();
		await withTenant(tenant, () => fhirClient.everything('p1'));
		expect(headers[0]['cache-control']).toBe('no-cache');
	});
});
