<script lang="ts">
	import Icpc2Picker from '$lib/components/Icpc2Picker.svelte';
	let { data, form } = $props();

</script>

<div class="rad-mellom">
	<h2>Journalnotater</h2>

</div>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}

{#if data.canSkrive}
	<section class="kort">
		<h3>Nytt notat</h3>
		<form method="POST" action="?/newValue">
		<div class="felt">
			<label for="tittel">Tittel</label>
			<input id="tittel" name="tittel" value="Konsultasjonsnotat" />
		</div>
		<div class="felt">
			<label for="subjektivt">Subjektivt</label>
			<textarea id="subjektivt" name="subjektivt" placeholder="Hva pasienten forteller"></textarea>
		</div>
		<div class="felt">
			<label for="objektivt">Objektivt</label>
			<textarea id="objektivt" name="objektivt" placeholder="Funn ved undersøkelse"></textarea>
		</div>
		<div class="felt">
			<label for="vurdering">Vurdering og plan</label>
			<textarea id="vurdering" name="vurdering" placeholder="Vurdering, tiltak og videre oppfølging"></textarea>
		</div>
		<fieldset>
			<legend>Kontaktdiagnose (ICPC-2)</legend>
			<Icpc2Picker name="diagnoseKode" />
		</fieldset>
			<button type="submit" class="primar">Lagre notat</button>
		</form>
	</section>
{/if}

{#if data.notes.length === 0}
	<p class="svak">Ingen journalnotater registrert.</p>
{:else}
	{#each data.notes as n (n.id)}
		<article class="kort">
			<div class="rad-mellom">
				<h3>{n.title}</h3>
				<span>
					{#if n.status === 'entered-in-error'}<span class="merke merke-fare">Feilført</span>{/if}
					<span class="merke">versjon {n.version}</span>
				</span>
			</div>
			<p class="svak">{n.date} · {n.forfatter}</p>
			{#each n.seksjoner as s (s.title)}
				<h4>{s.title}</h4>
				<p>{s.text}</p>
			{/each}
			{#if n.status !== 'entered-in-error'}
				<details>
					<summary>Merk som feilført</summary>
					<form method="POST" action="?/feilfor">
						<input type="hidden" name="id" value={n.id} />
						<div class="felt">
							<label for="begrunnelse-{n.id}">Begrunnelse</label>
							<input id="begrunnelse-{n.id}" name="begrunnelse" required minlength="5" />
							<small>Notatet blir stående, men merkes som feilført. Begrunnelsen lagres sammen med det.</small>
						</div>
						<button type="submit" class="fare liten">Merk som feilført</button>
					</form>
				</details>
			{/if}
		</article>
	{/each}
{/if}
