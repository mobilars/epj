<script lang="ts">
	let { data } = $props();
</script>

<h2>Innsynslogg</h2>
<p class="svak">
	Alle oppslag i journalen loggføres. Pasienten har rett til innsyn i denne loggen.
	Oppslag gjort på nødrett er merket særskilt.
</p>

{#if data.rader.length === 0}
	<p class="svak">Ingen loggførte oppslag.</p>
{:else}
	<div class="kort tabell-omslag">
		<table>
			<thead>
				<tr><th>Tidspunkt</th><th>Hvem</th><th>Rolle</th><th>Handling</th><th>Ressurs</th><th>App</th><th>IP</th></tr>
			</thead>
			<tbody>
				{#each data.rader as r (r.seq)}
					<tr>
						<td class="svak">{r.tidspunkt}</td>
						<td>
							{r.hvem}
							{#if r.nodrett}<span class="merke merke-fare">Nødrett</span>{/if}
							{#if r.utfall !== '0'}<span class="merke merke-advarsel">Avvist</span>{/if}
						</td>
						<td>{r.rolle}</td>
						<td>{r.hva}</td>
						<td class="mono">{r.ressurs}</td>
						<td>{r.app}</td>
						<td class="mono svak">{r.ip}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="rad">
		{#if data.side > 0}<a class="knapp liten" href="?side={data.side - 1}">Forrige</a>{/if}
		<span class="svak">Viser {data.side * 50 + 1}–{data.side * 50 + data.rader.length} av {data.total}</span>
		{#if (data.side + 1) * 50 < data.total}<a class="knapp liten" href="?side={data.side + 1}">Neste</a>{/if}
	</div>
{/if}
