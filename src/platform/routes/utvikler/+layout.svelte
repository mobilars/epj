<script lang="ts">
	import '$lib/styles/app.css';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let {
		data,
		children
	}: { data: { developer: { email: string; name: string } | null }; children: Snippet } = $props();

	const her = (prefix: string) => page.url.pathname === prefix || page.url.pathname.startsWith(prefix + '/');
</script>

<svelte:head><title>Utviklerportal · EPJ</title></svelte:head>

<div class="app">
	<nav class="topplinje" aria-label="Utviklerportal">
		<span class="merkenavn">EPJ</span>
		<span>Utviklerportal</span>
		{#if data.developer}
			<a href="/utvikler" aria-current={page.url.pathname === '/utvikler' ? 'page' : undefined}>Mine apper</a>
			<a href="/utvikler/dokumentasjon" aria-current={her('/utvikler/dokumentasjon') ? 'page' : undefined}>
				Dokumentasjon
			</a>
			<a href="/utvikler/api" aria-current={her('/utvikler/api') ? 'page' : undefined}>API-referanse</a>
			<a href="/utvikler/vilkar" aria-current={her('/utvikler/vilkar') ? 'page' : undefined}>Vilkår</a>
			<div class="hoyre-del">
				<span>{data.developer.name || data.developer.email}</span>
				<form method="POST" action="/utvikler/logg-inn?/loggUt">
					<button type="submit" class="liten">Logg ut</button>
				</form>
			</div>
		{/if}
	</nav>

	<main>{@render children()}</main>
</div>
