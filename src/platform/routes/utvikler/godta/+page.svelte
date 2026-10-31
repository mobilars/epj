<script lang="ts">
	let { data, form } = $props();
</script>

<div class="vilkar">
	<h1>Vilkårene er endret</h1>
	<p class="svak">
		{#if data.previous}
			Du godtok versjon {data.previous}. Gjeldende versjon er {data.terms.version}.
		{:else}
			Du har ikke godtatt utviklervilkårene ennå.
		{/if}
	</p>

	{#if form?.error}
		<div class="varsel varsel-feil" role="alert">{form.error}</div>
	{/if}

	<p class="ingress">{data.terms.intro}</p>

	{#each data.terms.sections as section (section.title)}
		<section>
			<h2>{section.title}</h2>
			{#each section.paragraphs as paragraph, i (i)}
				<p>{paragraph}</p>
			{/each}
		</section>
	{/each}

	<form method="POST" class="kort">
		<label class="avkryssing vilkarsvalg">
			<input type="checkbox" name="vilkar" value="godtatt" required />
			<span>Jeg har lest og godtar utviklervilkårene, versjon {data.terms.version}.</span>
		</label>
		<button type="submit" class="primar">Godta og fortsett</button>
	</form>
</div>
