<script lang="ts">
	import { page } from '$app/state';
	let { data, form } = $props();
	const faner = [
		{ key: 'inn', tekst: 'Innboks' },
		{ key: 'ut', tekst: 'Sendt' },
		{ key: 'uten-kvittering', tekst: 'Mangler kvittering' }
	];
</script>

<div class="rad-mellom">
	<h1>Meldinger</h1>
	{#if data.kanSende}
		<form method="POST" action="?/sendKo"><button type="submit">Send kø nå</button></form>
	{/if}
</div>

{#if form?.ok}
	<div class="varsel varsel-ok" role="status">Sendte {form.sendt} meldinger, {form.feilet} feilet.</div>
{/if}

<nav class="faner" aria-label="Meldingsfaner">
	{#each faner as f (f.key)}
		<a href="?filter={f.key}" aria-current={data.filter === f.key ? 'page' : undefined}>{f.tekst}</a>
	{/each}
</nav>

<div class="kort tabell-omslag">
	{#if data.meldinger.length === 0}
		<p class="svak">Ingen meldinger.</p>
	{:else}
		<table>
			<thead><tr><th>Tidspunkt</th><th>Type</th><th>Part</th><th>Pasient</th><th>Status</th><th></th></tr></thead>
			<tbody>
				{#each data.meldinger as m (m.id)}
					<tr>
						<td class="svak">{m.opprettet}</td>
						<td><a href="/meldinger/{m.id}">{m.type}</a></td>
						<td>{m.part}</td>
						<td>{#if m.patientId}<a href="/pasienter/{m.patientId}">Åpne journal</a>{:else}<span class="merke merke-advarsel">Ukjent</span>{/if}</td>
						<td>
							<span class="merke" class:merke-ok={m.status === 'kvittert' || m.status === 'behandlet'} class:merke-fare={m.status === 'avvist'}>{m.status}</span>
							{#if m.forsok > 0}<span class="svak">{m.forsok} forsøk</span>{/if}
							{#if m.detalj}<br /><span class="svak">{m.detalj}</span>{/if}
						</td>
						<td class="hoyre">
							{#if m.retning === 'inn' && m.status === 'mottatt'}
								<form method="POST" action="?/behandlet">
									<input type="hidden" name="id" value={m.id} />
									<button type="submit" class="liten">Marker behandlet</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
