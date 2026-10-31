<script lang="ts">
	let { data } = $props();
</script>

<div class="vilkar">
	<h1>Utviklervilkår</h1>
	<p class="svak">
		Versjon {data.terms.version} · sist endret {data.terms.updated}
		{#if data.accepted === data.terms.version}
			· <span class="merke merke-ok">godtatt</span>
		{:else if data.accepted}
			· <span class="merke merke-advarsel">du har godtatt versjon {data.accepted}</span>
		{/if}
	</p>

	<p class="ingress">{data.terms.intro}</p>

	{#each data.terms.sections as section (section.title)}
		<section>
			<h2>{section.title}</h2>
			{#each section.paragraphs as paragraph, i (i)}
				<p>{paragraph}</p>
			{/each}
		</section>
	{/each}

	<p class="svak liten">
		Dette er et utgangspunkt, ikke et ferdig juridisk dokument. Skal virkelige virksomheter bygge
		på det, bør det leses gjennom av noen med juridisk kompetanse først.
	</p>

	<p><a href="/utvikler/logg-inn">← Til portalen</a></p>
</div>
