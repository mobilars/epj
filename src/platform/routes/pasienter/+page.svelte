<script lang="ts">
	let { data, form } = $props();
</script>

<h1>Pasienter</h1>

<form method="GET" class="kort">
	<div class="rad">
		<div style="flex: 1 1 320px">
			<label for="sok">Søk på navn eller fødselsnummer</label>
			<input id="sok" name="sok" value={data.search} placeholder="Hansen, eller 11 siffer" autocomplete="off" data-shortcut-search />
		</div>
		<button type="submit" class="primar" style="align-self: flex-end">Søk</button>
	</div>
	<small class="svak">
		Pasienter du ikke er behandler av, kan du registrere deg på fra søkeresultatet. Alle søk loggføres.
	</small>
</form>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}

{#if data.notice}
	<div class="varsel varsel-advarsel" role="status">{data.notice}</div>
{/if}

<div class="kort">
	<h2>
		{#if data.search}Treff på «{data.search}»{:else}Mine pasienter ({data.countMine}){/if}
	</h2>

	{#if data.match.length === 0}
		<p class="svak">
			{#if data.search}
				Ingen treff blant dine pasienter.
			{:else}
				Du har ingen registrerte pasienter ennå.
			{/if}
		</p>
		{#if data.canRegister}
			<!-- A search that finds nobody is the ordinary way to a registration: the
			     patient is standing at the desk. The search term is carried over. -->
			<p>
				<a class="knapp knapp-primar" href="/pasienter/ny{data.search ? `?sok=${encodeURIComponent(data.search)}` : ''}">
					Registrer ny pasient
				</a>
			</p>
			{#if data.search}
				<small class="svak">Registrering avbrytes hvis fødselsnummeret allerede finnes.</small>
			{/if}
		{/if}
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

{#if data.others.length}
	<!-- Only enough to pick the right person. The record opens once the clinician
	     has taken the patient on, and that is what gets logged. -->
	<div class="kort">
		<h2>Andre pasienter i virksomheten</h2>
		<p class="svak">
			Du er ikke behandler av disse. Registrerer du deg, får du tilgang til journalen. Det krever ingen
			godkjenning, men loggføres på deg.
		</p>
		<div class="tabell-omslag">
			<table>
				<thead>
					<tr><th>Navn</th><th>Født</th><th>Alder</th><th></th></tr>
				</thead>
				<tbody>
					{#each data.others as p (p.id)}
						<tr>
							<td>
								{p.name}
								{#if p.possibleDuplicate}<span class="merke merke-advarsel">Registrert flere ganger</span>{/if}
							</td>
							<td class="mono">{p.nationalIdMasked ?? ''}</td>
							<td class="tall">{p.age ?? ''}</td>
							<td class="hoyre">
								<form method="POST" action="?/registrerBehandler">
									<input type="hidden" name="patientId" value={p.id} />
									<button type="submit" class="liten">Registrer som behandler av denne pasienten</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}
