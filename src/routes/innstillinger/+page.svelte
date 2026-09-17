<script lang="ts">
	import LayoutEditor from '$lib/components/LayoutEditor.svelte';
	let { data, form } = $props();
</script>

<h1>Innstillinger</h1>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}

<section class="kort">
	<h2>Arbeidsflaten</h2>
	<p class="svak">
		Kortene du møter når du logger inn. Virksomheten har et oppsett for alle; her ordner du
		ditt eget. Et kort du skjuler finnes fortsatt på sin egen side.
	</p>
	<LayoutEditor
		surface="arbeidsflate"
		cards={data.layouts.arbeidsflate.cards}
		layout={data.layouts.arbeidsflate.chosen}
		source={data.layouts.arbeidsflate.source}
		action="?/layout"
		resetAction="?/layoutReset"
	/>
</section>

<section class="kort">
	<h2>Pasientoversikten</h2>
	<p class="svak">Kortene på pasientens forside, i den rekkefølgen du vil ha dem.</p>
	<LayoutEditor
		surface="pasientoversikt"
		cards={data.layouts.pasientoversikt.cards}
		layout={data.layouts.pasientoversikt.chosen}
		source={data.layouts.pasientoversikt.source}
		action="?/layout"
		resetAction="?/layoutReset"
	/>
</section>

<section class="kort">
	<h2>Sidepanelet i journalen</h2>
	<p class="svak">
		Panelet til høyre i journalen er en app. Virksomheten bestemmer hva som står der til vanlig
		– her velger du for din egen del.
	</p>

	<form method="POST" action="?/sidepanel">
		<label class="avkryssing">
			<input type="radio" name="sidepanel" value="" checked={data.chosen === ''} />
			<strong>Som virksomheten har bestemt</strong>
			<span class="svak">
				{data.standard ? data.standard.name : 'Journalens eget notatfelt'}
			</span>
		</label>

		<label class="avkryssing">
			<input type="radio" name="sidepanel" value="journal" checked={data.chosen === 'journal'} />
			<strong>Journalens eget notatfelt</strong>
			<span class="svak">Subjektivt, objektivt, vurdering og plan.</span>
		</label>

		{#each data.apps as app (app.clientId)}
			<label class="avkryssing">
				<input type="radio" name="sidepanel" value={app.clientId} checked={data.chosen === app.clientId} />
				<strong>{app.name}</strong>
				<span class="svak">SMART-app</span>
			</label>
		{/each}

		<button type="submit" class="primar">Lagre</button>
	</form>
</section>
