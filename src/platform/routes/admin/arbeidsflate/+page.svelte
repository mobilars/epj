<script lang="ts">
	import LayoutEditor from '$lib/components/LayoutEditor.svelte';
	let { data, form } = $props();
</script>

<h2>Arbeidsflate og pasientoversikt</h2>
<p class="svak">
	Hvilke kort virksomhetens brukere møter, og i hvilken rekkefølge. Dette er oppsettet alle får til
	de ordner sitt eget under <em>Innstillinger</em>; den enkeltes valg går foran.
</p>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}

<section class="kort">
	<h3>Arbeidsflaten</h3>
	<p class="svak">Det brukeren ser når de logger inn.</p>
	<LayoutEditor
		surface="arbeidsflate"
		cards={data.layouts.arbeidsflate.cards}
		layout={data.layouts.arbeidsflate.chosen}
		source={data.layouts.arbeidsflate.source}
		action="?/layout"
	/>
	{#if data.layouts.arbeidsflate.source === 'virksomhet'}
		<form method="POST" action="?/layoutReset">
			<input type="hidden" name="flate" value="arbeidsflate" />
			<button type="submit" class="liten">Tilbake til standardoppsettet</button>
		</form>
	{/if}
</section>

<section class="kort">
	<h3>Pasientoversikten</h3>
	<p class="svak">Kortene på pasientens forside.</p>
	<LayoutEditor
		surface="pasientoversikt"
		cards={data.layouts.pasientoversikt.cards}
		layout={data.layouts.pasientoversikt.chosen}
		source={data.layouts.pasientoversikt.source}
		action="?/layout"
	/>
	{#if data.layouts.pasientoversikt.source === 'virksomhet'}
		<form method="POST" action="?/layoutReset">
			<input type="hidden" name="flate" value="pasientoversikt" />
			<button type="submit" class="liten">Tilbake til standardoppsettet</button>
		</form>
	{/if}
</section>
