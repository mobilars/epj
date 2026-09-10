import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Builds the command line tools into standalone files in `build/verktoy/`.
 *
 * Migration and seeding run under `vite-node` in development, but a container
 * image should not contain a build chain. This configuration packs the tools
 * into plain JavaScript, so the runtime can perform the schema change as its
 * own controlled step before new instances are rolled out:
 *
 *     node build/verktoy/migrer.js
 */
export default defineConfig({
	resolve: {
		alias: {
			$srv: fileURLToPath(new URL('../src/lib/server', import.meta.url)),
			$lib: fileURLToPath(new URL('../src/lib', import.meta.url))
		}
	},
	build: {
		outDir: 'build/verktoy',
		emptyOutDir: true,
		target: 'node22',
		ssr: true,
		minify: false,
		rollupOptions: {
			input: {
				migrate: fileURLToPath(new URL('./migrer.ts', import.meta.url)),
				seed: fileURLToPath(new URL('./seed.ts', import.meta.url))
			},
			// `pg` is loaded from node_modules in the image.
			external: ['pg'],
			output: { format: 'esm', entryFileNames: '[name].js' }
		}
	}
});
