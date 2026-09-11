<script lang="ts">
	import '$lib/styles/app.css';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let {
		data,
		children
	}: {
		data: {
			user: UserInfo | null;
			organisation: string;
			miljo: Miljo;
			apps: MenuApp[];
			recentPatients: { id: string; name: string; age: number | null }[];
		};
		children: Snippet;
	} = $props();

	type MenuApp = { clientId: string; name: string; inMainMenu: boolean; inPatientTabs: boolean };

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
	 * Apps in the main menu are the ones that work across patients - a worklist,
	 * an inbox - and start with no patient in context. Apps for one patient are
	 * reached from the record instead, under the patient's own Apper menu.
	 */
	const mainMenuApps = $derived(data.apps.filter((a) => a.inMainMenu));

	// The record is the working surface, and its tables are wide. Everything
	// else keeps the narrower measure that is easier to read.
	const wide = $derived(page.url.pathname.startsWith('/pasienter/'));

	let nyligApen = $state(false);


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
				<!-- Pasienter, with the ones you had open last hanging off it. Going
				     back to a patient you saw an hour ago is the commonest navigation
				     there is, and it was a search every time. -->
				<div class="nedtrekk">
					<a
						href="/pasienter"
						aria-current={page.url.pathname.startsWith('/pasienter') ? 'page' : undefined}
						onmouseenter={() => (nyligApen = true)}
					>
						Pasienter
					</a>
					{#if data.recentPatients?.length}
						<button
							type="button"
							class="menylenke pil"
							aria-expanded={nyligApen}
							aria-label="Nylige pasienter"
							onclick={() => (nyligApen = !nyligApen)}
						>
							▾
						</button>
						{#if nyligApen}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="nedtrekk-panel" onmouseleave={() => (nyligApen = false)}>
								<span class="nedtrekk-tittel">Nylig åpnet</span>
								{#each data.recentPatients as p (p.id)}
									<a href="/pasienter/{p.id}">
										{p.name}
										{#if p.age !== null}<span class="svak"> · {p.age} år</span>{/if}
									</a>
								{/each}
								<a href="/pasienter" class="svak">Søk etter pasient …</a>
							</div>
						{/if}
					{/if}
				</div>
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
				<a href="/apper/{app.clientId}" aria-current={page.url.pathname === `/apper/${app.clientId}` ? 'page' : undefined}>{app.name}</a>
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

	<!-- AGPL section 13: everyone who uses this over a network is entitled to the
	     source of the version they are running, so the offer belongs in the
	     interface and not only in the repository. -->
	<footer class="bunntekst">
		<span>© 2026 APUS Roland AS</span>
		<span aria-hidden="true">·</span>
		<a href="/kildekode">Fri programvare (AGPL v3) — hent kildekoden</a>
	</footer>
</div>
