import { describe, expect, it, vi } from 'vitest';
import { klientIp } from '../src/lib/server/http';
import type { RequestEvent } from '@sveltejs/kit';

/**
 * Klient-IP-en styrer både ratebegrensningen per adresse og feltet `source_ip`
 * i sikkerhetsloggen. Kan klienten velge den selv, er begge deler verdiløse.
 *
 * Inngangskontrolleren legger den ekte adressen bakerst i `X-Forwarded-For`.
 * Vi teller derfor `EPJ_TRUSTED_PROXY_HOPS` fra slutten, og ser bort fra alt
 * lenger til venstre - det kan klienten ha diktet opp.
 */
function event(xff: string | null, remote = '203.0.113.9'): RequestEvent {
	return {
		request: { headers: new Headers(xff ? { 'x-forwarded-for': xff } : {}) },
		getClientAddress: () => remote
	} as unknown as RequestEvent;
}

describe('utledning av klient-IP', () => {
	it('ser bort fra det klienten selv la inn foran', () => {
		expect(klientIp(event('1.2.3.4, 198.51.100.7'))).toBe('198.51.100.7');
	});

	it('godtar én oppføring når det er ett betrodd hopp', () => {
		// Klienten sendte ingen header; proxyen la inn den ekte adressen.
		expect(klientIp(event('198.51.100.7'))).toBe('198.51.100.7');
	});

	it('bruker tilkoblingens adresse når headeren mangler', () => {
		expect(klientIp(event(null))).toBe('203.0.113.9');
	});

	it('ignorerer en kjede som er kortere enn antall betrodde hopp', async () => {
		// Med to betrodde proxyer og bare én oppføring har forespørselen ikke
		// vært gjennom dem begge. Da er headeren klientens eget verk, og skal
		// ikke brukes. Tidligere ble den første oppføringen brukt uansett, og
		// hvem som helst kunne dermed velge sin egen adresse.
		vi.resetModules();
		const forrige = process.env.EPJ_TRUSTED_PROXY_HOPS;
		process.env.EPJ_TRUSTED_PROXY_HOPS = '2';
		try {
			const { klientIp: medToHopp } = await import('../src/lib/server/http');
			expect(medToHopp(event('192.0.2.66'))).toBe('203.0.113.9');
			expect(medToHopp(event('192.0.2.66, 1.2.3.4, 198.51.100.7'))).toBe('1.2.3.4');
		} finally {
			if (forrige === undefined) delete process.env.EPJ_TRUSTED_PROXY_HOPS;
			else process.env.EPJ_TRUSTED_PROXY_HOPS = forrige;
			vi.resetModules();
		}
	});
});
