import { sveltekit } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	build: { rollupOptions: { external: ['node:sqlite'] } },
	ssr: { external: ['node:sqlite'] },
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node'
	}
});
