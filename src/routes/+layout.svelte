<script lang="ts">
	import '$lib/styles/app.css';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let {
		data,
		children
	}: {
		data: { user: UserInfo | null; organisation: string; miljo: Miljo; apps: MenuApp[] };
		children: Snippet;
	} = $props();

	type MenuApp = { clientId: string; name: string; inMainMenu: boolean };

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

	// The sign-in page and the consent dialog have no navigation.
	const skjulNavigasjon = $derived(
		page.url.pathname.startsWith('/logg-inn') || page.url.pathname.startsWith('/oauth/authorize')
	);

	const showMiljobanner = $derived(!data.miljo.produksjon || data.miljo.integrations === 'mock');

	/**
	 * Starting an app needs a patient. The patient layout puts `patientId` in
	 * the page data, so it is here whenever a record is open - and the menu can
	 * start the app in one press rather than sending the user to a tab first.
	 */
	const patientId = $derived(page.data.patientId as string | undefined);
	const mainMenuApps = $derived(data.apps.filter((a) => a.inMainMenu));

	// The record is the working surface, and its tables are wide. Everything
	// else keeps the narrower measure that is easier to read.
	const wide = $derived(page.url.pathname.startsWith('/pasienter/'));


	// Marks the page as hydrated. The UI works without JavaScript, but hydration
	// rewrites input values among other things. The marker lets automated tests -
	// and debugging - know when it has finished.
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

			{#each mainMenuApps as app (app.clientId)}
				{#if patientId}
					<form method="POST" action="/pasienter/{patientId}/apper?/start" class="menyskjema">
						<input type="hidden" name="clientId" value={app.clientId} />
						<button type="submit" class="menylenke">{app.name}</button>
					</form>
				{:else}
					<a href="/pasienter" title="Velg en pasient først">{app.name}</a>
				{/if}
			{/each}


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

	<main class:bred={wide}>
		{@render children()}
	</main>
</div>
