import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Minimal Vite setup for the command line scripts (migration, seeding,
 * background jobs). Without the SvelteKit plugin, which restricts file access
 * to `src/` and therefore cannot run scripts outside the route tree.
 */
export default defineConfig({
	resolve: {
		alias: {
			$srv: fileURLToPath(new URL('../src/lib/server', import.meta.url)),
			$lib: fileURLToPath(new URL('../src/lib', import.meta.url))
		}
	},
	ssr: { noExternal: [] }
});
