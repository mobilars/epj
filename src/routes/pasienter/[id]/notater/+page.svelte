<script lang="ts">
	let { data, form } = $props();

</script>

<div class="rad-mellom">
	<h2>Journalnotater</h2>

</div>

{#if form?.feil}
	<div class="varsel varsel-feil" role="alert">{form.feil}</div>
{/if}

{#if data.kanSkrive}
	<section class="kort">
		<h3>Nytt notat</h3>
		<form method="POST" action="?/nytt">
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
			<div class="rad">
				<div style="flex: 0 0 8rem">
					<label for="diagnoseKode">Kode</label>
					<input id="diagnoseKode" name="diagnoseKode" placeholder="K86" />
				</div>
				<div style="flex: 1 1 16rem">
					<label for="diagnoseTekst">Tekst</label>
					<input id="diagnoseTekst" name="diagnoseTekst" placeholder="Hypertensjon ukomplisert" />
				</div>
			</div>
		</fieldset>
			<button type="submit" class="primar">Lagre notat</button>
		</form>
	</section>
{/if}

{#if data.notater.length === 0}
	<p class="svak">Ingen journalnotater registrert.</p>
{:else}
	{#each data.notater as n (n.id)}
		<article class="kort">
			<div class="rad-mellom">
				<h3>{n.tittel}</h3>
				<span>
					{#if n.status === 'entered-in-error'}<span class="merke merke-fare">Feilført</span>{/if}
					<span class="merke">versjon {n.versjon}</span>
				</span>
			</div>
			<p class="svak">{n.dato} · {n.forfatter}</p>
			{#each n.seksjoner as s (s.tittel)}
				<h4>{s.tittel}</h4>
				<p>{s.tekst}</p>
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
