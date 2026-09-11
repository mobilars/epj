<script lang="ts">
	let { data } = $props();
</script>

<div class="rad-mellom">
	<h1>{data.app.name}</h1>
	<a class="knapp" href="/apper/{data.app.clientId}/start" target="_blank" rel="noopener">Åpne i eget vindu</a>
</div>

{#if !data.openInNewTab}
	<p class="svak">
	Appen kjører hos leverandøren sin og autoriserer seg selv mot journalen. Den ser bare det
	rollen din tillater, og oppslagene den gjør loggføres på deg.
</p>
{/if}

{#if data.openInNewTab}
	<section class="kort">
		<h3>Appen åpnes i sitt eget vindu</h3>
		<p class="svak">
			Denne appen trenger sine egne informasjonskapsler, og nettleseren gir den dem bare
			når den er sitt eget vindu og ikke en ramme inne i journalen.
		</p>
		<p>
			<a class="knapp-primar" href="/apper/{data.app.clientId}/start" target="_blank" rel="noopener">Åpne {data.app.name}</a>
		</p>
	</section>
{:else}
	<iframe class="appramme" src={data.launchUrl} title={data.app.name} allow="clipboard-write"></iframe>
{/if}

<style>
	.appramme {
		width: 100%;
		height: min(78vh, 900px);
		border: 1px solid var(--kant);
		border-radius: 8px;
		background: var(--flate);
	}
</style>
