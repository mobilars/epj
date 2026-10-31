<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: { platformHostname: string | null; egetHostname: string; waitingApps: number }; children: Snippet } = $props();
</script>

<h1>Plattformadministrasjon</h1>
<nav class="faner" aria-label="Plattformfaner">
	<a href="/systemadmin" aria-current={page.url.pathname === '/systemadmin' ? 'page' : undefined}>Virksomheter</a>
	<a href="/systemadmin/apper" aria-current={page.url.pathname === '/systemadmin/apper' ? 'page' : undefined}>
		Appkatalog
		{#if data.waitingApps > 0}
			<span class="merke merke-advarsel" title="Apper som venter på vurdering">{data.waitingApps} til vurdering</span>
		{/if}
	</a>
</nav>

{#if !data.platformHostname}
	<div class="varsel varsel-advarsel" role="status">
		<strong>EPJ_PLATFORM_HOSTNAME er ikke satt.</strong>
		Plattformadministrasjonen er da tilgjengelig på samme vertsnavn som virksomhetene.
		I produksjon bør den ha et eget vertsnavn, slik at den kan skjermes på nettverksnivå.
	</div>
{/if}

{@render children()}
