<script lang="ts">
	let { data, form } = $props();
</script>

<h1>Oppgjør mot Helfo</h1>

{#if form?.feil}<div class="varsel varsel-feil" role="alert">{form.feil}</div>{/if}
{#if form?.ok}<div class="varsel varsel-ok" role="status">{form.melding}</div>{/if}

<form method="GET" class="kort">
	<div class="rad">
		<div style="flex:0 0 11rem"><label for="fra">Fra</label><input id="fra" name="fra" type="date" value={data.fra} /></div>
		<div style="flex:0 0 11rem"><label for="til">Til</label><input id="til" name="til" type="date" value={data.til} /></div>
		<button type="submit" style="align-self:flex-end">Oppdater</button>
	</div>
</form>

<section class="kort">
	<h2>Klart til innsending</h2>
	<p>
		<strong class="tall">{data.forhand.antallKort}</strong> regningskort ·
		refusjon <strong class="tall">{data.forhand.sumRefusjon}</strong> ·
		egenandel <strong class="tall">{data.forhand.sumEgenandel}</strong>
	</p>
	{#each data.forhand.advarsler as a}
		<div class="varsel varsel-advarsel">{a}</div>
	{/each}
	{#if data.kanSende && data.forhand.antallKort > 0}
		<form method="POST" action="?/generer">
			<input type="hidden" name="fra" value={data.fra} />
			<input type="hidden" name="til" value={data.til} />
			<button type="submit" class="primar">Generer oppgjør</button>
		</form>
	{/if}
</section>

{#if data.avviste.length}
	<section class="kort">
		<h2>Avviste regningskort</h2>
		<p class="svak">Disse må rettes og sendes på nytt.</p>
		<table>
			<thead><tr><th>Dato</th><th>Pasient</th><th class="hoyre">Refusjon</th><th>Årsak</th></tr></thead>
			<tbody>
				{#each data.avviste as k (k.id)}
					<tr>
						<td>{k.dato}</td>
						<td><a href="/pasienter/{k.patientId}/oppgjor">Åpne</a></td>
						<td class="hoyre tall">{k.refusjon}</td>
						<td>{k.arsak}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}

<section class="kort tabell-omslag">
	<h2>Innsendinger</h2>
	{#if data.oppgjor.length === 0}
		<p class="svak">Ingen oppgjør generert.</p>
	{:else}
		<table>
			<thead><tr><th>Periode</th><th class="hoyre">Kort</th><th class="hoyre">Refusjon</th><th>Status</th><th>Sendt</th><th></th></tr></thead>
			<tbody>
				{#each data.oppgjor as o (o.id)}
					<tr>
						<td>{o.periode}</td>
						<td class="hoyre tall">{o.antall}</td>
						<td class="hoyre tall">{o.sumRefusjon}</td>
						<td><span class="merke" class:merke-ok={o.status === 'avregnet'}>{o.status}</span></td>
						<td class="svak">{o.sendt ?? ''}</td>
						<td class="hoyre">
							{#if o.status === 'generert' && data.kanSende}
								<form method="POST" action="?/send">
									<input type="hidden" name="id" value={o.id} />
									<button type="submit" class="liten primar">Send til Helfo</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
