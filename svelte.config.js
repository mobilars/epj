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
				'base-uri': ['none'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
