import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Minimal Vite-oppsett for kommandolinjeskriptene (migrering, seeding,
 * bakgrunnsjobber). Uten SvelteKit-pluginen, som begrenser filtilgangen til
 * `src/` og dermed ikke kan kjøre skript utenfor rutetreet.
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
