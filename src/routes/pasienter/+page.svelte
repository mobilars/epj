<script lang="ts">
	let { data } = $props();
</script>

<h1>Pasienter</h1>

<form method="GET" class="kort">
	<div class="rad">
		<div style="flex: 1 1 320px">
			<label for="sok">Søk på navn eller fødselsnummer</label>
			<input id="sok" name="sok" value={data.search} placeholder="Hansen, eller 11 siffer" autocomplete="off" />
		</div>
		<button type="submit" class="primar" style="align-self: flex-end">Søk</button>
	</div>
	<small class="svak">
		Søket viser bare pasienter du har dokumentert behandlingsrelasjon til. Alle søk loggføres.
	</small>
</form>

{#if data.error}
	<div class="varsel varsel-feil">{data.error}</div>
{/if}

<div class="kort">
	<h2>
		{#if data.search}Treff på «{data.search}»{:else}Mine pasienter ({data.countMine}){/if}
	</h2>

	{#if data.match.length === 0}
		<p class="svak">
			{#if data.search}
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
					{#each data.match as p (p.id)}
						<tr>
							<td>
								<a href="/pasienter/{p.id}">{p.name}</a>
								{#if p.dod}<span class="merke merke-fare">Død</span>{/if}
							</td>
							<td class="mono">{p.nationalIdMasked ?? p.birthDate ?? ''}</td>
							<td class="tall">{p.age ?? ''}</td>
							<td>{p.gender}</td>
							<td>{p.phone ?? ''}</td>
							<td>{p.gp ?? ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
