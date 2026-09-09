<script lang="ts">
	let { data } = $props();
</script>

<h1>Pasienter</h1>

<form method="GET" class="kort">
	<div class="rad">
		<div style="flex: 1 1 320px">
			<label for="sok">Søk på navn eller fødselsnummer</label>
			<input id="sok" name="sok" value={data.sok} placeholder="Hansen, eller 11 siffer" autocomplete="off" />
		</div>
		<button type="submit" class="primar" style="align-self: flex-end">Søk</button>
	</div>
	<small class="svak">
		Søket viser bare pasienter du har dokumentert behandlingsrelasjon til. Alle søk loggføres.
	</small>
</form>

{#if data.feil}
	<div class="varsel varsel-feil">{data.feil}</div>
{/if}

<div class="kort">
	<h2>
		{#if data.sok}Treff på «{data.sok}»{:else}Mine pasienter ({data.antallMine}){/if}
	</h2>

	{#if data.treff.length === 0}
		<p class="svak">
			{#if data.sok}
				Ingen treff. Har du ikke behandlingsrelasjon til pasienten, vises hen ikke her.
			{:else}
				Du har ingen registrerte pasienter ennå.
			{/if}
		</p>
	{:else}
		<div class="tabell-omslag">
			<table>
				<thead>
					<tr><th>Navn</th><th>Født</th><th>Alder</th><th>Kjønn</th><th>Telefon</th><th>Fastlege</th></tr>
				</thead>
				<tbody>
					{#each data.treff as p (p.id)}
						<tr>
							<td>
								<a href="/pasienter/{p.id}">{p.navn}</a>
								{#if p.dod}<span class="merke merke-fare">Død</span>{/if}
							</td>
							<td class="mono">{p.fodselsnummerMaskert ?? p.fodselsdato ?? ''}</td>
							<td class="tall">{p.alder ?? ''}</td>
							<td>{p.kjonn}</td>
							<td>{p.telefon ?? ''}</td>
							<td>{p.fastlege ?? ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
