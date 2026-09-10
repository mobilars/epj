<script lang="ts">
	let { data } = $props();
</script>

<h1>Innstillinger</h1>

<section class="kort">
	<h2>Sidepanelet i journalen</h2>
	<p class="svak">
		Panelet til høyre i journalen er en app. Virksomheten bestemmer hva som står der til vanlig
		– her velger du for din egen del.
	</p>

	<form method="POST">
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
