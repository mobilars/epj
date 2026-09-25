<script lang="ts">
	import LayoutEditor from '$lib/components/LayoutEditor.svelte';
	let { data, form } = $props();
</script>

<h1>Innstillinger</h1>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}

<section class="kort">
	<h2>Utseende</h2>
	<form method="POST" action="?/theme">
		<fieldset class="temavalg">
			<legend>Fargetema</legend>
			<label class="avkryssing">
				<input type="radio" name="tema" value="system" checked={data.theme === 'system'} />
				Som maskinen er innstilt
			</label>
			<label class="avkryssing">
				<input type="radio" name="tema" value="light" checked={data.theme === 'light'} />
				Lyst
			</label>
			<label class="avkryssing">
				<input type="radio" name="tema" value="dark" checked={data.theme === 'dark'} />
				Mørkt
			</label>
		</fieldset>
		<p class="svak">Utskrifter blir alltid svart på hvitt.</p>
		<button type="submit" class="liten primar">Lagre</button>
	</form>
</section>

<section class="kort">
	<h2>Hurtigtaster</h2>
	<p class="svak">
		Enkeltaster som <kbd>/</kbd> for søk og <kbd>n</kbd> for nytt notat. Trykk <kbd>?</kbd> for å se alle.
		Slå dem av hvis du bruker talestyring eller får dem ved et uhell.
	</p>
	<form method="POST" action="?/shortcuts">
		<label class="avkryssing">
			<input type="checkbox" name="hurtigtaster" value="ja" checked={data.shortcuts} />
			Bruk hurtigtaster
		</label>
		<button type="submit" class="liten primar">Lagre</button>
	</form>
</section>

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
