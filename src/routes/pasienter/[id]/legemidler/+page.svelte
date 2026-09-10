<script lang="ts">
	let { data, form } = $props();

</script>

<div class="rad-mellom">
	<h2>Legemidler</h2>
	<div class="rad">
		<span class="merke merke-info">Kilde: Sentral forskrivningsmodul ({data.mode})</span>

	</div>
</div>

{#if data.error}
	<div class="varsel varsel-feil" role="alert">Kunne ikke hente legemiddellisten: {data.error}</div>
{/if}
{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}
{#if form?.ok}
	<div class="varsel varsel-ok" role="status">
		Resept {form.prescriptionId} er sendt til e-resept.
		{#if form.alerts?.length}
			<ul>{#each form.alerts as v}<li>{v}</li>{/each}</ul>
		{/if}
	</div>
{/if}

{#if data.list?.deviation?.length}
	<div class="varsel varsel-advarsel">
		<strong>Avvik som må avklares</strong>
		<ul>{#each data.list.deviation as a}<li>{a}</li>{/each}</ul>
	</div>
{/if}

{#if data.canForskrive}
	<!-- <details> framfor en JavaScript-styrt bryter: skjemaet virker også før
	     siden er hydrert, og for brukere uten JavaScript. -->
	<section class="kort">
		<h3>Ny resept</h3>
		<form method="POST" action="?/forskriv">
		<div class="rad">
			<div style="flex: 2 1 14rem"><label for="navn">Legemiddel</label><input id="navn" name="navn" required /></div>
			<div style="flex: 0 0 8rem"><label for="atc">ATC-kode</label><input id="atc" name="atc" placeholder="A10BA02" /></div>
			<div style="flex: 0 0 8rem"><label for="styrke">Styrke</label><input id="styrke" name="styrke" placeholder="500 mg" /></div>
			<div style="flex: 0 0 9rem"><label for="form">Form</label><input id="form" name="form" placeholder="tablett" /></div>
		</div>
		<div class="felt"><label for="dosering">Dosering</label><input id="dosering" name="dosering" required placeholder="1 tablett morgen og kveld" /></div>
		<div class="rad">
			<div style="flex: 1 1 12rem"><label for="indikasjon">Indikasjon</label><input id="indikasjon" name="indikasjon" /></div>
			<div style="flex: 0 0 7rem"><label for="mengde">Pakninger</label><input id="mengde" name="mengde" type="number" min="1" value="1" /></div>
			<div style="flex: 0 0 7rem"><label for="reiterasjon">Reiterasjoner</label><input id="reiterasjon" name="reiterasjon" type="number" min="0" max="3" value="0" /></div>
		</div>
		<fieldset>
			<legend>Refusjon (blå resept)</legend>
			<div class="rad">
				<div style="flex: 0 0 9rem"><label for="refusjonKode">Refusjonskode</label><input id="refusjonKode" name="refusjonKode" placeholder="T90" /></div>
				<div style="flex: 1 1 12rem"><label for="refusjonHjemmel">Hjemmel</label><input id="refusjonHjemmel" name="refusjonHjemmel" placeholder="§ 5-14" /></div>
			</div>
		</fieldset>
			<button type="submit" class="primar">Forskriv</button>
		</form>
	</section>
{/if}

<div class="kort">
	<h3>Legemiddelliste</h3>
	{#if !data.list || data.list.medications.length === 0}
		<p class="svak">Ingen legemidler registrert.</p>
	{:else}
		<div class="tabell-omslag">
			<table>
				<thead>
					<tr><th>Legemiddel</th><th>Dosering</th><th>ATC</th><th>Status</th><th>Refusjon</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.list.medications as l (l.prescriptionId)}
						<tr>
							<td>{l.name}</td>
							<td>{l.dosage}</td>
							<td class="mono">{l.atc ?? ''}</td>
							<td>
								<span class="merke" class:merke-ok={l.status === 'aktiv'} class:merke-advarsel={l.status === 'seponert'}>{l.status}</span>
							</td>
							<td>{l.reimbursement ? `${l.reimbursement.legalBasis} ${l.reimbursement.code}` : ''}</td>
							<td class="hoyre">
								{#if l.status === 'aktiv' && data.canForskrive}
									<form method="POST" action="?/seponer" class="rad">
										<input type="hidden" name="reseptId" value={l.prescriptionId} />
										<input name="arsak" placeholder="Årsak" style="width: 9rem" />
										<button type="submit" class="liten">Seponer</button>
									</form>
								{:else if l.status === 'aktiv' && data.canFornye}
									<form method="POST" action="?/fornye">
										<input type="hidden" name="reseptId" value={l.prescriptionId} />
										<button type="submit" class="liten">Forny</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="svak">Sist oppdatert fra SFM: {data.list.updated_at}</p>
	{/if}
</div>

<details class="kort">
	<summary>Kommunikasjon med SFM</summary>
	<table>
		<thead><tr><th>Tidspunkt</th><th>Operasjon</th><th>Status</th><th>Resept</th><th>Feil</th></tr></thead>
		<tbody>
			{#each data.history as h (h.id)}
				<tr>
					<td class="svak">{h.created_at}</td>
					<td>{h.operation}</td>
					<td><span class="merke" class:merke-ok={h.status === 'ok'} class:merke-fare={h.status === 'feilet'}>{h.status}</span></td>
					<td class="mono">{h.reseptid ?? ''}</td>
					<td class="svak">{h.feilmelding ?? ''}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</details>
