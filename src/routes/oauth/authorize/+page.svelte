<script lang="ts">
	let { data, form } = $props();
</script>

<div class="smal" style="max-width: 560px">
	<h1>Gi tilgang til «{data.klient.navn}»?</h1>

	{#if form?.feil}
		<div class="varsel varsel-feil" role="alert">{form.feil}</div>
	{/if}

	<div class="kort">
		<div class="rad-mellom">
			<div>
				<strong>{data.klient.navn}</strong><br />
				<span class="svak mono">{data.klient.clientId}</span>
			</div>
			<span class="merke merke-info">
				{data.klient.kategori === 'smart-ehr' ? 'Journalstartet app' : 'Selvstendig app'}
			</span>
		</div>

		{#if data.launch.patientId}
			<div class="varsel varsel-info" style="margin-top: 1rem">
				Appen får tilgang til <strong>{data.launch.pasientNavn ?? `pasient ${data.launch.patientId}`}</strong>
				{#if data.launch.encounterId}og den åpne konsultasjonen{/if}.
			</div>
		{/if}

		<h3>Appen ber om å kunne</h3>
		{#if data.scopes.length === 0}
			<div class="varsel varsel-feil">
				Ingen av tilgangene appen ber om er tillatt for rollen din. Du kan ikke gi tilgang.
			</div>
		{:else}
			<ul>
				{#each data.scopes as s (s.scope)}
					<li>{s.beskrivelse} <span class="svak mono">({s.scope})</span></li>
				{/each}
			</ul>
		{/if}

		{#if data.avvisteScopes.length}
			<h3>Ikke tillatt for din rolle</h3>
			<ul class="svak">
				{#each data.avvisteScopes as s (s.scope)}
					<li>{s.beskrivelse} <span class="mono">({s.scope})</span></li>
				{/each}
			</ul>
			<p class="svak">Disse blir ikke gitt, selv om du godkjenner.</p>
		{/if}

		{#if !data.klient.databehandleravtale}
			<div class="varsel varsel-advarsel">
				Det er ikke registrert databehandleravtale for denne appen. Kontroller med
				systemansvarlig før du gir tilgang til helseopplysninger.
			</div>
		{/if}

		<p class="svak">
			Du gir tilgang som <strong>{data.bruker.navn}</strong>. Appen kan aldri se mer enn du selv
			har tilgang til, og alle oppslag appen gjør blir loggført på deg.
		</p>

		<form method="POST" action="?/godkjenn" class="rad">
			<input type="hidden" name="client_id" value={data.foresporsel.client_id} />
			<input type="hidden" name="redirect_uri" value={data.foresporsel.redirect_uri} />
			<input type="hidden" name="state" value={data.foresporsel.state} />
			<input type="hidden" name="scope" value={data.innsnevret} />
			<input type="hidden" name="code_challenge" value={data.foresporsel.code_challenge} />
			<input type="hidden" name="code_challenge_method" value={data.foresporsel.code_challenge_method} />
			{#if data.foresporsel.nonce}<input type="hidden" name="nonce" value={data.foresporsel.nonce} />{/if}
			{#if data.launch.patientId}<input type="hidden" name="patient_id" value={data.launch.patientId} />{/if}
			{#if data.launch.encounterId}<input type="hidden" name="encounter_id" value={data.launch.encounterId} />{/if}
			<button type="submit" class="primar" disabled={data.scopes.length === 0}>Gi tilgang</button>
		</form>
		<form method="POST" action="?/avslaa" style="margin-top: 0.5rem">
			<input type="hidden" name="client_id" value={data.foresporsel.client_id} />
			<input type="hidden" name="redirect_uri" value={data.foresporsel.redirect_uri} />
			<input type="hidden" name="state" value={data.foresporsel.state} />
			<button type="submit">Avbryt</button>
		</form>
	</div>
</div>
