<script lang="ts">
	let { data, form } = $props();
</script>

<div class="rad-mellom">
	<h2>Beslutningsstøtte (CDS Hooks)</h2>
	<a href="/admin">← Administrasjon</a>
</div>

<p class="svak">
	Journalen spør disse tjenestene om råd når en journal åpnes. Svaret er kort – et varsel, et
	forslag, en lenke – og kan ikke skrive i journalen eller hindre noen i å gjøre noe. Ingen
	pasientopplysninger sendes ut: tjenesten får pasient-id og adressen til FHIR-endepunktet, og må
	hente det den trenger med sitt eget token.
</p>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}

<section class="kort">
	<h3>Registrer tjeneste</h3>
	<form method="POST" action="?/registrer">
		<div class="feltrad">
			<div style="flex:1 1 20rem">
				<label for="url">Adresse</label>
				<input id="url" name="url" required placeholder="https://tjeneste.example" />
				<small class="svak">Vi leser <span class="mono">/cds-services</span> fra denne adressen.</small>
			</div>
			<div class="fast" style="align-self:flex-end">
				<button type="submit" class="primar">Les tjenester</button>
			</div>
		</div>
	</form>
</section>

<section class="kort">
	<h3>Registrerte tjenester ({data.services.length})</h3>
	{#each data.services as s (s.id)}
		<div class="kort">
			<div class="rad-mellom">
				<div>
					<strong>{s.title ?? s.service_id}</strong>
					<span class="merke">{s.hook}</span>
				</div>
				<span class="merke" class:merke-ok={s.enabled} class:merke-fare={!s.enabled}>
					{s.enabled ? 'på' : 'av'}
				</span>
			</div>
			{#if s.description}<p class="svak">{s.description}</p>{/if}
			<p class="svak liten mono">{s.discovery_url}/cds-services/{s.service_id}</p>
			<div class="rad">
				<form method="POST" action="?/status">
					<input type="hidden" name="id" value={s.id} />
					<input type="hidden" name="enabled" value={s.enabled ? 'nei' : 'ja'} />
					<button type="submit" class="liten">{s.enabled ? 'Slå av' : 'Slå på'}</button>
				</form>
				<form method="POST" action="?/fjern">
					<input type="hidden" name="id" value={s.id} />
					<button type="submit" class="liten fare">Fjern</button>
				</form>
			</div>
		</div>
	{:else}
		<p class="svak">Ingen tjenester er registrert.</p>
	{/each}
</section>
