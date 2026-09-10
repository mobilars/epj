<script lang="ts">
	let { data, form } = $props();

</script>

<div class="rad-mellom">
	<h2>Brukere og roller</h2>
</div>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.temporaryPassword}
	<div class="varsel varsel-ok" role="status">
		Midlertidig passord: <strong class="mono">{form.temporaryPassword}</strong><br />
		Formidle det i en annen kanal enn e-post, og be brukeren bytte det ved første pålogging.
	</div>
{/if}

<section class="kort">
	<h3>Ny bruker</h3>
	<form method="POST" action="?/create">
		<div class="rad">
			<div style="flex:1 1 12rem"><label for="brukernavn">Brukernavn</label><input id="brukernavn" name="brukernavn" required /></div>
			<div style="flex:1 1 14rem"><label for="navn">Navn</label><input id="navn" name="navn" /></div>
			<div style="flex:0 0 10rem"><label for="hpr">HPR-nummer</label><input id="hpr" name="hpr" /></div>
			<div style="flex:1 1 14rem"><label for="practitionerId">Practitioner-id</label><input id="practitionerId" name="practitionerId" /></div>
		</div>
		<fieldset>
			<legend>Roller</legend>
			{#each data.roles as r (r.code)}
				<label style="font-weight:400">
					<input type="checkbox" name="roller" value={r.code} style="width:auto" />
					<strong>{r.name}</strong> <span class="svak">{r.description}</span>
				</label>
			{/each}
		</fieldset>
		<button type="submit" class="primar">Opprett bruker</button>
	</form>
</section>

<div class="kort tabell-omslag">
	<table>
		<thead><tr><th>Bruker</th><th>Roller</th><th>Status</th><th>MFA</th><th>Sist pålogget</th><th></th></tr></thead>
		<tbody>
			{#each data.users as b (b.id)}
				<tr>
					<td>
						<strong>{b.name}</strong><br />
						<span class="svak mono">{b.username}</span>
						{#if b.hpr}<span class="svak">· HPR {b.hpr}</span>{/if}
					</td>
					<td>
						<form method="POST" action="?/roles">
							<input type="hidden" name="id" value={b.id} />
							{#each data.roles as r (r.code)}
								<label style="font-weight:400; display:inline-block; margin-right:.6rem">
									<input type="checkbox" name="roller" value={r.code} checked={b.roles.includes(r.code)} style="width:auto" />
									{r.name}
								</label>
							{/each}
							<button type="submit" class="liten">Lagre roller</button>
						</form>
					</td>
					<td>
						<span class="merke" class:merke-ok={b.status === 'aktiv'} class:merke-fare={b.status !== 'aktiv'}>{b.status}</span>
						{#if b.locked}<span class="merke merke-advarsel">Låst</span>{/if}
					</td>
					<td>{b.mfa ? 'Ja' : 'Nei'}</td>
					<td class="svak">{b.lastLogin ?? 'aldri'}</td>
					<td class="hoyre">
						<form method="POST" action="?/status" style="display:inline">
							<input type="hidden" name="id" value={b.id} />
							<input type="hidden" name="status" value={b.status === 'aktiv' ? 'sperret' : 'aktiv'} />
							<button type="submit" class="liten">{b.status === 'aktiv' ? 'Sperr' : 'Aktiver'}</button>
						</form>
						<form method="POST" action="?/newPassword" style="display:inline">
							<input type="hidden" name="id" value={b.id} />
							<button type="submit" class="liten">Nytt passord</button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
