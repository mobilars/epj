<script lang="ts">
	let { data } = $props();
</script>

<div class="rutenett">
	<section class="kort">
		<h2>Tilstand</h2>
		<ul>
			<li>FHIR-server: <span class="merke" class:merke-ok={data.fhirOppe} class:merke-fare={!data.fhirOppe}>{data.fhirOppe ? 'oppe' : 'nede'}</span></li>
			<li>Skjemaversjon: <span class="mono">{data.skjemaversjon}</span></li>
			<li>Aktive brukere: <strong class="tall">{data.antallBrukere}</strong></li>
			<li>Registrerte apper: <strong class="tall">{data.antallApper}</strong></li>
			<li>Meldinger uten kvittering: <strong class="tall">{data.ventendeKvitteringer}</strong></li>
		</ul>
	</section>

	<section class="kort">
		<h2>Sikkerhetsloggens integritet</h2>
		{#if data.loggkjede.gyldig}
			<div class="varsel varsel-ok">
				Hash-kjeden er ubrutt. {data.loggkjede.kontrollerte} innslag kontrollert.
			</div>
		{:else}
			<div class="varsel varsel-feil" role="alert">
				<strong>Brudd i loggkjeden.</strong> Rader kan ha blitt endret eller fjernet utenom
				applikasjonen. Dette er et avvik som skal håndteres etter virksomhetens rutine.
			</div>
		{/if}
	</section>

	<section class="kort">
		<h2>Konfigurasjon</h2>
		<ul>
			<li>Integrasjoner: <span class="merke">{data.miljo.integrasjoner}</span></li>
			<li>HelseID: <span class="merke" class:merke-ok={data.miljo.helseId}>{data.miljo.helseId ? 'på' : 'av'}</span></li>
			<li>Lokal testinnlogging: <span class="merke" class:merke-advarsel={data.miljo.testinnlogging}>{data.miljo.testinnlogging ? 'på' : 'av'}</span></li>
			<li>Totrinnsverifisering påkrevd: <span class="merke" class:merke-ok={data.miljo.mfa}>{data.miljo.mfa ? 'ja' : 'nei'}</span></li>
		</ul>
	</section>

	<section class="kort">
		<h2>Nødrettsoppslag til gjennomgang</h2>
		{#if data.nodrett.length === 0}
			<p class="svak">Ingen nødrettsoppslag venter på gjennomgang.</p>
		{:else}
			<table>
				<thead><tr><th>Tidspunkt</th><th>Hvem</th><th>Pasient</th></tr></thead>
				<tbody>
					{#each data.nodrett as n (n.seq)}
						<tr>
							<td class="svak">{n.tidspunkt}</td>
							<td>{n.hvem}</td>
							<td><a href="/admin/logg?patientId={n.patientId}">Se logg</a></td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>
