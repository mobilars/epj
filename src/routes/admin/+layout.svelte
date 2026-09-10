<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: { canUsers: boolean; canApper: boolean; canLog: boolean }; children: Snippet } = $props();

	const faner = $derived(
		[
			{ href: '/admin', text: 'Oversikt', show: true },
			{ href: '/admin/brukere', text: 'Brukere og roller', show: data.canUsers },
			{ href: '/admin/apper', text: 'SMART-apper', show: data.canApper },
			{ href: '/admin/logg', text: 'Sikkerhetslogg', show: data.canLog }
		].filter((f) => f.show)
	);
</script>

<h1>Administrasjon</h1>
<nav class="faner" aria-label="Administrasjonsfaner">
	{#each faner as f (f.href)}
		<a href={f.href} aria-current={page.url.pathname === f.href ? 'page' : undefined}>{f.text}</a>
	{/each}
</nav>
{@render children()}
