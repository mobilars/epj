import { describe, expect, it, vi } from 'vitest';
import { clientIp } from '../src/lib/server/http';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * The client IP governs both the per-address rate limit and the `source_ip`
 * field in the security log. If the client can choose it, both are worthless.
 *
 * The ingress controller puts the real address last in `X-Forwarded-For`. We
 * therefore count `EPJ_TRUSTED_PROXY_HOPS` from the end, and disregard
 * everything further left - the client may have invented that.
 */
function event(xff: string | null, remote = '203.0.113.9'): RequestEvent {
	return {
		request: { headers: new Headers(xff ? { 'x-forwarded-for': xff } : {}) },
		getClientAddress: () => remote
	} as unknown as RequestEvent;
}

describe('utledning av klient-IP', () => {
	it('ser bort fra det klienten selv la inn foran', () => {
		expect(clientIp(event('1.2.3.4, 198.51.100.7'))).toBe('198.51.100.7');
	});

	it('godtar én oppføring når det er ett betrodd hopp', () => {
		// The client sent no header; the proxy inserted the real address.
		expect(clientIp(event('198.51.100.7'))).toBe('198.51.100.7');
	});

	it('bruker tilkoblingens adresse når headeren mangler', () => {
		expect(clientIp(event(null))).toBe('203.0.113.9');
	});

	it('ignorerer en kjede som er kortere enn antall betrodde hopp', async () => {
		// With two trusted proxies and only one entry, the request has not been
		// through both of them. The header is then the client's own work, and must
		// not be used. Previously the first entry was used regardless, and anyone
		// could thereby choose their own address.
		vi.resetModules();
		const previous = process.env.EPJ_TRUSTED_PROXY_HOPS;
		process.env.EPJ_TRUSTED_PROXY_HOPS = '2';
		try {
			const { clientIp: withToHops } = await import('../src/lib/server/http');
			expect(withToHops(event('192.0.2.66'))).toBe('203.0.113.9');
			expect(withToHops(event('192.0.2.66, 1.2.3.4, 198.51.100.7'))).toBe('1.2.3.4');
		} finally {
			if (previous === undefined) delete process.env.EPJ_TRUSTED_PROXY_HOPS;
			else process.env.EPJ_TRUSTED_PROXY_HOPS = previous;
			vi.resetModules();
		}
	});
});
