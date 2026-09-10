<script lang="ts">
	let { data, form } = $props();
	const v = $derived(data.organisation);
</script>

<div class="rad-mellom">
	<h2>{v.name}</h2>
	<div class="rad">
		<a class="knapp" href="/systemadmin/{data.organisation.id}/brukere">Brukere</a>
		<a href="/systemadmin">← Alle virksomheter</a>
	</div>
</div>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.stored}<div class="varsel varsel-ok" role="status">Endringene er lagret.</div>{/if}

{#if data.partitionExists === false && !data.isPlatform}
	<div class="varsel varsel-feil" role="alert">
		Virksomheten har partisjons-id {v.partitionId} i registeret, men HAPI FHIR kjenner ingen
		partisjon med navnet <span class="mono">{v.id}</span>. Kliniske spørringer vil feile til
		partisjonen er gjenopprettet.
	</div>
{:else if data.partisjonsfeil}
	<div class="varsel varsel-advarsel" role="status">
		Kunne ikke kontrollere partisjonen mot HAPI FHIR: {data.partisjonsfeil}
	</div>
{/if}

<div class="kort">
	<h3>Nøkkeltall</h3>
	<ul class="stabel">
		{#each data.number as t (t.label)}
			<li>{t.label}: <strong class="tall">{t.n}</strong></li>
		{/each}
	</ul>
	{#if data.roles.length}
		<p class="svak">
			Roller i bruk: {data.roles.map((r) => `${r.role} (${r.n})`).join(', ')}
		</p>
	{/if}
</div>

<div class="kort">
	<h3>Adresser</h3>
	<dl>
		<dt>Maskinnavn / partisjon</dt><dd class="mono">{v.id} · {v.partitionId ?? 'ingen partisjon'}</dd>
		<dt>FHIR-endepunkt</dt><dd class="mono">{data.fhirBaseUrl}</dd>
		<dt>OAuth issuer</dt><dd class="mono">{data.issuer}</dd>
		<dt>SMART-metadata</dt><dd class="mono">{data.wellKnown}</dd>
		<dt>Opprettet</dt><dd>{v.created_at}</dd>
	</dl>
</div>

<section class="kort">
	<h3>Endre virksomheten</h3>
	<p class="svak">
		Maskinnavn, organisasjonsnummer og partisjons-id kan ikke endres: de er knyttet til de
		kliniske dataene og til loggen.
	</p>
	<form method="POST" action="?/store">
		<div class="rad">
			<div style="flex:1 1 16rem"><label for="navn">Navn</label><input id="navn" name="navn" value={v.name} /></div>
			<div style="flex:0 0 9rem"><label for="herId">HER-id</label><input id="herId" name="herId" value={v.herId ?? ''} /></div>
			<div style="flex:0 0 9rem"><label for="kommunenummer">Kommunenummer</label><input id="kommunenummer" name="kommunenummer" value={v.municipality_code ?? ''} /></div>
		</div>
		<div class="rad">
			<div style="flex:1 1 16rem"><label for="vertsnavn">Vertsnavn</label><input id="vertsnavn" name="vertsnavn" value={v.hostname ?? ''} /></div>
			<div style="flex:1 1 18rem"><label for="baseUrl">Utadvendt adresse</label><input id="baseUrl" name="baseUrl" type="url" value={v.baseUrl} /></div>
		</div>
		<fieldset>
			<legend>Påkrevd innlogging</legend>
			<p class="svak liten">
				Det svakeste virksomheten godtar. Alt sterkere godtas også, så en virksomhet som strammer
				inn slipper å tenke på hvilke måter som må slås av.
			</p>
			{#each data.loginLevels as level (level.code)}
				<label class="avkryssing">
					<input
						type="radio"
						name="innloggingsniva"
						value={level.code}
						checked={v.loginLevel === level.code}
					/>
					<strong>{level.name}</strong>
					<span class="svak">{level.description}</span>
				</label>
			{/each}
		</fieldset>

		<div><label for="merknad">Merknad</label><input id="merknad" name="merknad" value={v.note ?? ''} /></div>
		<button type="submit" class="primar">Lagre</button>
	</form>
</section>

<style>
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.35rem 1rem;
		margin: 0;
	}
	dt {
		font-weight: 500;
		color: var(--tekst-svak);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
