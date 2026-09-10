<script lang="ts">
	import '$lib/styles/app.css';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { data, children }: { data: { user: UserInfo | null; organisation: string; miljo: Miljo }; children: Snippet } = $props();

	type UserInfo = {
		name: string;
		roles: string[];
		rollenavn: string[];
		permissions: string[];
		mate: string;
		amr: string;
	};
	type Miljo = { integrations: string; testLogin: boolean; produksjon: boolean };

	const has = (permission: string) => data.user?.permissions.includes(permission) ?? false;

	// Påloggingssiden og samtykkedialogen har ingen navigasjon.
	const skjulNavigasjon = $derived(
		page.url.pathname.startsWith('/logg-inn') || page.url.pathname.startsWith('/oauth/authorize')
	);

	const showMiljobanner = $derived(!data.miljo.produksjon || data.miljo.integrations === 'mock');

	// Markerer at siden er hydrert. Grensesnittet virker uten JavaScript, men
	// hydreringen skriver blant annet input-verdier på nytt. Markøren gjør det
	// mulig for automatiserte tester - og for feilsøking - å vite når den er ferdig.
	$effect(() => {
		document.documentElement.dataset.hydrert = 'ja';
	});
</script>

<svelte:head>
	<title>EPJ · {data.organisation}</title>
</svelte:head>

<div class="app">
	{#if showMiljobanner}
		<div class="miljobanner" role="status">
			Testmiljø · integrasjoner i «{data.miljo.integrations}»-modus · ikke bruk ekte pasientopplysninger
		</div>
	{/if}

	{#if !skjulNavigasjon && data.user}
		<nav class="topplinje" aria-label="Hovedmeny">
			<span class="merkenavn">EPJ</span>
			<a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Arbeidsflate</a>
			{#if has('journal:les')}
				<a href="/pasienter" aria-current={page.url.pathname.startsWith('/pasienter') ? 'page' : undefined}>Pasienter</a>
			{/if}
			{#if has('melding:les')}
				<a href="/meldinger" aria-current={page.url.pathname.startsWith('/meldinger') ? 'page' : undefined}>Meldinger</a>
			{/if}
			{#if has('oppgjor:registrer') || has('oppgjor:send')}
				<a href="/oppgjor" aria-current={page.url.pathname.startsWith('/oppgjor') ? 'page' : undefined}>Oppgjør</a>
			{/if}
			{#if has('admin:brukere') || has('admin:apper') || has('admin:logg')}
				<a href="/admin" aria-current={page.url.pathname.startsWith('/admin') ? 'page' : undefined}>Administrasjon</a>
			{/if}
			{#if has('plattform:administrer')}
				<a href="/systemadmin" aria-current={page.url.pathname.startsWith('/systemadmin') ? 'page' : undefined}>Plattform</a>
			{/if}
			<div class="hoyre-del">
				<span>
					{data.user.name}
					{#if data.user.rollenavn.length}<span class="merke">{data.user.rollenavn.join(', ')}</span>{/if}
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
