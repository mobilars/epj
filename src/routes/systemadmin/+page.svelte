<script lang="ts">
	let { data, form } = $props();

	const statustekst: Record<string, string> = {
		active: 'Aktiv',
		suspendert: 'Suspendert',
		avviklet: 'Avviklet'
	};
</script>

<div class="rad-mellom">
	<h2>Virksomheter</h2>
	<span class="svak">{data.organisations.length} registrert</span>
</div>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.statusSatt}<div class="varsel varsel-ok" role="status">Status endret · {form.statusSatt}</div>{/if}
{#if form?.created_at}
	<div class="varsel varsel-ok" role="status">
		Virksomheten <strong>{form.created_at}</strong> er opprettet med egen FHIR-partisjon.
		{#if form.adminUsername}
			<br />
			Administratorbruker <strong class="mono">{form.adminUsername}</strong> med midlertidig passord
			<strong class="mono">{form.temporaryPassword}</strong>.
			Formidle det i en annen kanal enn e-post; brukeren må bytte det ved første pålogging.
		{/if}
	</div>
{/if}

{#if !data.multitenant}
	<div class="varsel varsel-advarsel" role="status">
		<strong>Partisjonering er slått av</strong> (EPJ_FHIR_MULTITENANT). Alle virksomheter deler
		da samme kliniske lager. Slå den på i FHIR-serveren og i konfigurasjonen før flere
		virksomheter tas i bruk.
	</div>
{:else if !data.partitioning.ok}
	<div class="varsel varsel-feil" role="alert">
		Får ikke kontakt med partisjonsadministrasjonen i HAPI FHIR: {data.partitioning.error}
	</div>
{/if}

<section class="kort">
	<h3>Ny virksomhet</h3>
	<p class="svak">
		Maskinnavnet blir partisjonsnavn i HAPI FHIR og inngår i FHIR-adressene. Det kan ikke endres
		etterpå. Vertsnavnet avgjør hvilken virksomhet en forespørsel havner i - to virksomheter kan
		ikke dele vertsnavn.
	</p>
	<form method="POST" action="?/opprett">
		<div class="rad">
			<div style="flex:0 0 12rem">
				<label for="id">Maskinnavn</label>
				<input id="id" name="id" required pattern="[a-z][a-z0-9-]{'{'}1,30{'}'}" placeholder="legekontoret" />
			</div>
			<div style="flex:1 1 16rem">
				<label for="navn">Virksomhetens navn</label>
				<input id="navn" name="navn" required placeholder="Legekontoret AS" />
			</div>
			<div style="flex:0 0 11rem">
				<label for="organisasjonsnummer">Organisasjonsnummer</label>
				<input id="organisasjonsnummer" name="organisasjonsnummer" required inputmode="numeric" />
			</div>
			<div style="flex:0 0 9rem">
				<label for="herId">HER-id</label>
				<input id="herId" name="herId" inputmode="numeric" />
			</div>
			<div style="flex:0 0 9rem">
				<label for="kommunenummer">Kommunenummer</label>
				<input id="kommunenummer" name="kommunenummer" inputmode="numeric" />
			</div>
		</div>
		<div class="rad">
			<div style="flex:1 1 16rem">
				<label for="vertsnavn">Vertsnavn</label>
				<input id="vertsnavn" name="vertsnavn" placeholder="legekontoret.epj.example.no" />
			</div>
			<div style="flex:1 1 18rem">
				<label for="baseUrl">Utadvendt adresse (issuer)</label>
				<input id="baseUrl" name="baseUrl" required type="url" placeholder="https://legekontoret.epj.example.no" />
			</div>
		</div>
		<fieldset>
			<legend>Første systemansvarlige</legend>
			<p class="svak">
				Valgfritt. Opprettes inne i den nye virksomheten med rollen systemansvarlig, og får et
				midlertidig passord som vises én gang.
			</p>
			<div class="rad">
				<div style="flex:1 1 12rem">
					<label for="adminBrukernavn">Brukernavn</label>
					<input id="adminBrukernavn" name="adminBrukernavn" />
				</div>
				<div style="flex:1 1 14rem">
					<label for="adminNavn">Navn</label>
					<input id="adminNavn" name="adminNavn" />
				</div>
			</div>
		</fieldset>
		<div>
			<label for="merknad">Merknad</label>
			<input id="merknad" name="merknad" />
		</div>
		<button type="submit" class="primar">Opprett virksomhet</button>
	</form>
</section>

<div class="kort tabell-omslag">
	<table>
		<thead>
			<tr>
				<th>Virksomhet</th>
				<th>Vertsnavn</th>
				<th>Partisjon</th>
				<th>Brukere</th>
				<th>Logg</th>
				<th>Status</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.organisations as v (v.id)}
				<tr>
					<td>
						<a href="/systemadmin/{v.id}"><strong>{v.name}</strong></a><br />
						<span class="svak mono">{v.id}</span>
						<span class="svak">· org.nr {v.organisation_number}</span>
						{#if v.isPlatform}<span class="merke">plattform</span>{/if}
					</td>
					<td>
						{#if v.hostname}<span class="mono">{v.hostname}</span>{:else}<span class="svak">ikke satt</span>{/if}
						<br /><span class="svak mono">{v.baseUrl}</span>
					</td>
					<td>
						{#if v.isPlatform}
							<span class="svak">ingen</span>
						{:else}
							<span class="mono">{v.partitionId}</span>
							{#if v.partitionExists === false}
								<br /><span class="merke merke-fare">mangler i HAPI</span>
							{:else if v.partitionExists === null}
								<br /><span class="svak">ikke kontrollert</span>
							{/if}
						{/if}
					</td>
					<td>{v.countUsers}</td>
					<td>
						{v.countAuditEntry}
						{#if v.lastAktivitet}<br /><span class="svak">{v.lastAktivitet}</span>{/if}
					</td>
					<td>
						<span
							class="merke"
							class:merke-ok={v.status === 'aktiv'}
							class:merke-advarsel={v.status === 'suspendert'}
							class:merke-fare={v.status === 'avviklet'}>{statustekst[v.status]}</span>
					</td>
					<td>
						{#if !v.isPlatform}
							<form method="POST" action="?/status">
								<input type="hidden" name="id" value={v.id} />
								{#if v.status === 'aktiv'}
									<button type="submit" name="status" value="suspendert" class="liten">Suspender</button>
								{:else}
									<button type="submit" name="status" value="aktiv" class="liten">Aktiver</button>
								{/if}
							</form>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<p class="svak">
	Suspensjon virker umiddelbart: alle sesjoner avsluttes og alle utstedte tokens tilbakekalles.
	Kliniske data i partisjonen røres ikke - de blir liggende til virksomheten aktiveres igjen eller
	avvikles etter avtale.
</p>
