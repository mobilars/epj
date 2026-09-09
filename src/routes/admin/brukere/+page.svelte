<script lang="ts">
	let { data, form } = $props();
	let viserNy = $state(false);
</script>

<div class="rad-mellom">
	<h2>Brukere og roller</h2>
	<button type="button" class="primar" onclick={() => (viserNy = !viserNy)}>{viserNy ? 'Avbryt' : 'Ny bruker'}</button>
</div>

{#if form?.feil}<div class="varsel varsel-feil" role="alert">{form.feil}</div>{/if}
{#if form?.midlertidigPassord}
	<div class="varsel varsel-ok" role="status">
		Midlertidig passord: <strong class="mono">{form.midlertidigPassord}</strong><br />
		Formidle det i en annen kanal enn e-post, og be brukeren bytte det ved første pålogging.
	</div>
{/if}

{#if viserNy}
	<form method="POST" action="?/opprett" class="kort">
		<div class="rad">
			<div style="flex:1 1 12rem"><label for="brukernavn">Brukernavn</label><input id="brukernavn" name="brukernavn" required /></div>
			<div style="flex:1 1 14rem"><label for="navn">Navn</label><input id="navn" name="navn" /></div>
			<div style="flex:0 0 10rem"><label for="hpr">HPR-nummer</label><input id="hpr" name="hpr" /></div>
			<div style="flex:1 1 14rem"><label for="practitionerId">Practitioner-id</label><input id="practitionerId" name="practitionerId" /></div>
		</div>
		<fieldset>
			<legend>Roller</legend>
			{#each data.roller as r (r.kode)}
				<label style="font-weight:400">
					<input type="checkbox" name="roller" value={r.kode} style="width:auto" />
					<strong>{r.navn}</strong> <span class="svak">{r.beskrivelse}</span>
				</label>
			{/each}
		</fieldset>
		<button type="submit" class="primar">Opprett bruker</button>
	</form>
{/if}

<div class="kort tabell-omslag">
	<table>
		<thead><tr><th>Bruker</th><th>Roller</th><th>Status</th><th>MFA</th><th>Sist pålogget</th><th></th></tr></thead>
		<tbody>
			{#each data.brukere as b (b.id)}
				<tr>
					<td>
						<strong>{b.navn}</strong><br />
						<span class="svak mono">{b.brukernavn}</span>
						{#if b.hpr}<span class="svak">· HPR {b.hpr}</span>{/if}
					</td>
					<td>
						<form method="POST" action="?/roller">
							<input type="hidden" name="id" value={b.id} />
							{#each data.roller as r (r.kode)}
								<label style="font-weight:400; display:inline-block; margin-right:.6rem">
									<input type="checkbox" name="roller" value={r.kode} checked={b.roller.includes(r.kode)} style="width:auto" />
									{r.navn}
								</label>
							{/each}
							<button type="submit" class="liten">Lagre roller</button>
						</form>
					</td>
					<td>
						<span class="merke" class:merke-ok={b.status === 'aktiv'} class:merke-fare={b.status !== 'aktiv'}>{b.status}</span>
						{#if b.laast}<span class="merke merke-advarsel">Låst</span>{/if}
					</td>
					<td>{b.mfa ? 'Ja' : 'Nei'}</td>
					<td class="svak">{b.sisteInnlogging ?? 'aldri'}</td>
					<td class="hoyre">
						<form method="POST" action="?/status" style="display:inline">
							<input type="hidden" name="id" value={b.id} />
							<input type="hidden" name="status" value={b.status === 'aktiv' ? 'sperret' : 'aktiv'} />
							<button type="submit" class="liten">{b.status === 'aktiv' ? 'Sperr' : 'Aktiver'}</button>
						</form>
						<form method="POST" action="?/nyttPassord" style="display:inline">
							<input type="hidden" name="id" value={b.id} />
							<button type="submit" class="liten">Nytt passord</button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
