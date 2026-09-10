import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
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
				'frame-ancestors': ['none'],
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
