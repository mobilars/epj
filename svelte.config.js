import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		/*
		 * CSRF-kontrollen gjøres i hooks.server.ts i stedet for her.
		 *
		 * Rammeverkets kontroll gjelder alle skjemaposteringer fra andre
		 * opphav, og den slo ut token-endepunktet: en offentlig SMART-app
		 * kjører i nettleseren og poster skjemakodet innhold fra sitt eget
		 * opphav, slik OAuth krever. `trustedOrigins` er statisk oppsett, mens
		 * de tillatte appene står i klientregisteret og er ulike per
		 * virksomhet.
		 *
		 * Vernet er derfor flyttet, ikke fjernet: hooks krever samme opphav for
		 * alle skjemaposteringer til sidene, og lar bare API-endepunktene - som
		 * ikke bruker informasjonskapsler i det hele tatt - ta imot fra andre.
		 */
		csrf: { trustedOrigins: ['*'] },
		alias: { $srv: 'src/lib/server' },
		/**
		 * Innholdssikkerhetspolicy for HTML-svar.
		 *
		 * Den settes her, ikke som en egen header i hooks, fordi SvelteKit da
		 * legger nonce på sine egne innebygde skript. En håndskrevet CSP uten den
		 * koblingen blokkerer hydreringen, og etterlater et grensesnitt som ser
		 * riktig ut men ikke virker.
		 */
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'connect-src': ['self'],
				'form-action': ['self'],
				/*
				 * 'self', ikke 'none'.
				 *
				 * En SMART-app kjører i en ramme inne i journalen, og sender seg selv
				 * til journalens autorisasjonsendepunkt for å be om samtykke. Da rammes
				 * journalen inn av seg selv. Med 'none' ble samtykkedialogen blokkert,
				 * og appen kom aldri gjennom påloggingen.
				 *
				 * Fremmede nettsteder kan fortsatt ikke ramme inn journalen - det er
				 * det clickjacking-vernet handler om.
				 */
				'frame-ancestors': ['self'],
				/*
				 * SMART-apper kjøres i en ramme inne i journalen. Bare registrerte
				 * apper får en ramme i det hele tatt - adressen kommer fra
				 * klientregisteret, som er en administrativ handling - men CSP settes
				 * statisk her og kan ikke liste opp appene per forespørsel. 'https:'
				 * er derfor så snevert dette kan bli uten en dynamisk policy.
				 *
				 * Merk at frame-src bare styrer hva vi kan ramme inn. Den sier
				 * ingenting om hvem som kan ramme inn oss - det er frame-ancestors
				 * over, og den er fortsatt 'none'.
				 */
				'frame-src': ['self', 'https:'],
				'base-uri': ['none'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
