<script lang="ts">
	let { data } = $props();
</script>

<h2>Innsynslogg</h2>
<p class="svak">
	Alle oppslag i journalen loggføres. Pasienten har rett til innsyn i denne loggen.
	Oppslag gjort på nødrett er merket særskilt.
</p>

{#if data.rows.length === 0}
	<p class="svak">Ingen loggførte oppslag.</p>
{:else}
	<div class="kort tabell-omslag">
		<table>
			<thead>
				<tr><th>Tidspunkt</th><th>Hvem</th><th>Rolle</th><th>Handling</th><th>Ressurs</th><th>App</th><th>IP</th></tr>
			</thead>
			<tbody>
				{#each data.rows as r (r.seq)}
					<tr>
						<td class="svak">{r.timestamp}</td>
						<td>
							{r.hvem}
							{#if r.emergencyAccess}<span class="merke merke-fare">Nødrett</span>{/if}
							{#if r.outcome !== '0'}<span class="merke merke-advarsel">Avvist</span>{/if}
						</td>
						<td>{r.role}</td>
						<td>{r.hva}</td>
						<td class="mono">{r.resource}</td>
						<td>{r.app}</td>
						<td class="mono svak">{r.ip}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="rad">
		{#if data.page > 0}<a class="knapp liten" href="?side={data.page - 1}">Forrige</a>{/if}
		<span class="svak">Viser {data.page * 50 + 1}–{data.page * 50 + data.rows.length} av {data.total}</span>
		{#if (data.page + 1) * 50 < data.total}<a class="knapp liten" href="?side={data.page + 1}">Neste</a>{/if}
	</div>
{/if}
