import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: { rollupOptions: { external: ['node:sqlite'] } },
	ssr: { external: ['node:sqlite'] },
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['tests/setup.ts'],
		// Integrasjonstestene oppretter hver sin database; kjør filene sekvensielt
		// for å holde antallet samtidige tilkoblinger nede.
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 60_000
	}
});
