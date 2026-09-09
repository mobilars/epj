<script lang="ts">
	let { data, form } = $props();

	const kanTa = (typer: string[], type: string) => typer.includes(type);
</script>

<div class="rad-mellom">
	<h2>Meldinger</h2>

</div>

{#if form?.feil}<div class="varsel varsel-feil" role="alert">{form.feil}</div>{/if}

{#if data.kanSende}
	<section class="kort">
		<h3>Ny dialogmelding</h3>
		<form method="POST" action="?/dialog">
		<div class="rad">
			<div style="flex:1 1 18rem">
				<label for="mottaker-d">Mottaker</label>
				<select id="mottaker-d" name="mottaker" required>
					<option value="">Velg mottaker</option>
					{#each data.mottakere.filter((m) => kanTa(m.typer, 'DIALOG_HELSEFAGLIG') || kanTa(m.typer, 'DIALOG_NOTAT') || kanTa(m.typer, 'DIALOG_FORESPORSEL')) as m (m.herId)}
						<option value={m.herId}>{m.navn}</option>
					{/each}
				</select>
			</div>
			<div style="flex:0 0 12rem">
				<label for="type-d">Type</label>
				<select id="type-d" name="type"><option value="notat">Notat</option><option value="foresporsel">Forespørsel</option></select>
			</div>
			<div style="flex:0 0 8rem"><label for="hpr-d">HPR-nummer</label><input id="hpr-d" name="hpr" /></div>
		</div>
		<div class="felt"><label for="innhold">Innhold</label><textarea id="innhold" name="innhold" required></textarea></div>
			<button type="submit" class="primar">Send</button>
		</form>
	</section>

	<section class="kort">
		<h3>Ny henvisning</h3>
		<form method="POST" action="?/henvisning">
		<div class="rad">
			<div style="flex:1 1 18rem">
				<label for="mottaker-h">Mottaker</label>
				<select id="mottaker-h" name="mottaker" required>
					<option value="">Velg mottaker</option>
					{#each data.mottakere.filter((m) => kanTa(m.typer, 'HENVIS')) as m (m.herId)}
						<option value={m.herId}>{m.navn}</option>
					{/each}
				</select>
			</div>
			<div style="flex:0 0 10rem">
				<label for="hastegrad">Hastegrad</label>
				<select id="hastegrad" name="hastegrad">
					<option value="ordinaer">Ordinær</option><option value="haster">Haster</option><option value="akutt">Akutt</option>
				</select>
			</div>
			<div style="flex:0 0 8rem"><label for="hpr-h">HPR-nummer</label><input id="hpr-h" name="hpr" /></div>
		</div>
		<div class="rad">
			<div style="flex:0 0 8rem"><label for="diagnoseKode-h">Diagnose</label><input id="diagnoseKode-h" name="diagnoseKode" placeholder="K86" /></div>
			<div style="flex:1 1 14rem"><label for="diagnoseTekst-h">Diagnosetekst</label><input id="diagnoseTekst-h" name="diagnoseTekst" /></div>
		</div>
		<div class="felt"><label for="problemstilling">Problemstilling</label><textarea id="problemstilling" name="problemstilling" required></textarea></div>
		<div class="felt"><label for="anamnese">Anamnese</label><textarea id="anamnese" name="anamnese"></textarea></div>
		<div class="felt"><label for="onsket">Ønsket undersøkelse</label><input id="onsket" name="onsket" /></div>
		<label><input type="checkbox" name="informert" value="på" checked style="width:auto" /> Pasienten er informert om henvisningen</label>
			<button type="submit" class="primar">Send henvisning</button>
		</form>
	</section>
{/if}

<div class="kort tabell-omslag">
	{#if data.meldinger.length === 0}
		<p class="svak">Ingen meldinger for denne pasienten.</p>
	{:else}
		<table>
			<thead><tr><th>Tidspunkt</th><th>Retning</th><th>Type</th><th>Part</th><th>Status</th><th>Kvittering</th></tr></thead>
			<tbody>
				{#each data.meldinger as m (m.id)}
					<tr>
						<td class="svak">{m.opprettet}</td>
						<td>{m.retning === 'ut' ? 'Sendt' : 'Mottatt'}</td>
						<td><a href="/meldinger/{m.id}">{m.type}</a></td>
						<td>{m.part}</td>
						<td>
							<span class="merke" class:merke-ok={m.status === 'kvittert'} class:merke-fare={m.status === 'avvist'}>{m.status}</span>
							{#if m.detalj}<br /><span class="svak">{m.detalj}</span>{/if}
						</td>
						<td>{m.apprec ?? ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
