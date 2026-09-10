import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Bygger kommandolinjeverktøyene til frittstående filer i `build/verktoy/`.
 *
 * Migrering og seeding kjøres i utvikling med `vite-node`, men et
 * containerbilde skal ikke inneholde en byggekjede. Denne konfigurasjonen
 * pakker verktøyene til vanlig JavaScript, slik at driftsmiljøet kan kjøre
 * skjemaendringen som et eget, kontrollert steg før nye instanser rulles ut:
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
				migrer: fileURLToPath(new URL('./migrer.ts', import.meta.url)),
				seed: fileURLToPath(new URL('./seed.ts', import.meta.url))
			},
			// `pg` lastes fra node_modules i bildet.
			external: ['pg'],
			output: { format: 'esm', entryFileNames: '[name].js' }
		}
	}
});
