<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: { kanBrukere: boolean; kanApper: boolean; kanLogg: boolean }; children: Snippet } = $props();

	const faner = $derived(
		[
			{ href: '/admin', tekst: 'Oversikt', vis: true },
			{ href: '/admin/brukere', tekst: 'Brukere og roller', vis: data.kanBrukere },
			{ href: '/admin/apper', tekst: 'SMART-apper', vis: data.kanApper },
			{ href: '/admin/logg', tekst: 'Sikkerhetslogg', vis: data.kanLogg }
		].filter((f) => f.vis)
	);
</script>

<h1>Administrasjon</h1>
<nav class="faner" aria-label="Administrasjonsfaner">
	{#each faner as f (f.href)}
		<a href={f.href} aria-current={page.url.pathname === f.href ? 'page' : undefined}>{f.tekst}</a>
	{/each}
</nav>
{@render children()}
