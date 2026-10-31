<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Kildekode og lisens</title></svelte:head>

<h2>Kildekode og lisens</h2>

<section class="kort">
	<p>
		Denne journalen er fri programvare. Den er opphavsrettslig beskyttet av
		<strong>APUS Roland AS</strong> og utgitt under
		<strong>GNU Affero General Public License, versjon 3 eller senere</strong>.
	</p>
	<p>
		Du har rett til å bruke, studere, endre og dele programmet videre. Setter du opp
		en endret utgave som andre bruker over nett, må du tilby dem kildekoden til
		din utgave — det er § 13 i lisensen, og den gjelder selv om du aldri deler ut
		selve programmet.
	</p>

	<p>
		<a class="knapp-primar" href={data.sourceUrl} rel="noopener">Hent kildekoden</a>
	</p>

	{#if data.version}
		<p class="svak">
			Denne installasjonen kjører versjon <span class="mono">{data.version}</span>.
		</p>
	{:else}
		<p class="svak">
			Versjonen er ikke oppgitt av driftsmiljøet. Sett <span class="mono">EPJ_VERSION</span>
			til utgaven bildet er bygget fra, så peker denne siden på nøyaktig den koden som kjører.
		</p>
	{/if}

	<p class="svak">
		Programmet distribueres uten noen garanti, heller ikke underforstått garanti
		om salgbarhet eller egnethet for et bestemt formål.
	</p>
</section>
