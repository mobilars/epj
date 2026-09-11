<script lang="ts">
	let { data } = $props();
</script>

<div class="rad-mellom">
	<h1>{data.app.name}</h1>
	<a class="knapp" href={data.launchUrl} target="_blank" rel="noopener">Åpne i eget vindu</a>
</div>

<p class="svak">
	Appen kjører hos leverandøren sin og autoriserer seg selv mot journalen. Den ser bare det
	rollen din tillater, og oppslagene den gjør loggføres på deg.
</p>

<iframe class="appramme" src={data.launchUrl} title={data.app.name} allow="clipboard-write"></iframe>

<style>
	.appramme {
		width: 100%;
		height: min(78vh, 900px);
		border: 1px solid var(--kant);
		border-radius: 8px;
		background: var(--flate);
	}
</style>
