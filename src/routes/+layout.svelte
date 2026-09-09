<script lang="ts">
	import '$lib/styles/app.css';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { data, children }: { data: { bruker: BrukerInfo | null; organisasjon: string; miljo: Miljo }; children: Snippet } = $props();

	type BrukerInfo = {
		navn: string;
		roller: string[];
		rollenavn: string[];
		rettigheter: string[];
		mate: string;
		amr: string;
	};
	type Miljo = { integrasjoner: string; testinnlogging: boolean; produksjon: boolean };

	const har = (rettighet: string) => data.bruker?.rettigheter.includes(rettighet) ?? false;

	// Påloggingssiden og samtykkedialogen har ingen navigasjon.
	const skjulNavigasjon = $derived(
		page.url.pathname.startsWith('/logg-inn') || page.url.pathname.startsWith('/oauth/authorize')
	);

	const visMiljobanner = $derived(!data.miljo.produksjon || data.miljo.integrasjoner === 'mock');
</script>

<svelte:head>
	<title>EPJ · {data.organisasjon}</title>
</svelte:head>

<div class="app">
	{#if visMiljobanner}
		<div class="miljobanner" role="status">
			Testmiljø · integrasjoner i «{data.miljo.integrasjoner}»-modus · ikke bruk ekte pasientopplysninger
		</div>
	{/if}

	{#if !skjulNavigasjon && data.bruker}
		<nav class="topplinje" aria-label="Hovedmeny">
			<span class="merkenavn">EPJ</span>
			<a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Arbeidsflate</a>
			{#if har('journal:les')}
				<a href="/pasienter" aria-current={page.url.pathname.startsWith('/pasienter') ? 'page' : undefined}>Pasienter</a>
			{/if}
			{#if har('melding:les')}
				<a href="/meldinger" aria-current={page.url.pathname.startsWith('/meldinger') ? 'page' : undefined}>Meldinger</a>
			{/if}
			{#if har('oppgjor:registrer') || har('oppgjor:send')}
				<a href="/oppgjor" aria-current={page.url.pathname.startsWith('/oppgjor') ? 'page' : undefined}>Oppgjør</a>
			{/if}
			{#if har('admin:brukere') || har('admin:apper') || har('admin:logg')}
				<a href="/admin" aria-current={page.url.pathname.startsWith('/admin') ? 'page' : undefined}>Administrasjon</a>
			{/if}
			<div class="hoyre-del">
				<span>
					{data.bruker.navn}
					{#if data.bruker.rollenavn.length}<span class="merke">{data.bruker.rollenavn.join(', ')}</span>{/if}
				</span>
				<form method="POST" action="/logg-ut">
					<button type="submit" class="liten">Logg ut</button>
				</form>
			</div>
		</nav>
	{/if}

	<main>
		{@render children()}
	</main>
</div>
