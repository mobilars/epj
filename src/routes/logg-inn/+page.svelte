<script lang="ts">
	import { page } from '$app/state';
	let { data, form } = $props();

	let brukernavn = $state('');
	let visEngangskode = $state(false);

	$effect(() => {
		if (form?.krevErMfa) visEngangskode = true;
		if (form?.brukernavn) brukernavn = form.brukernavn;
	});

	const feilFraUrl = $derived(page.url.searchParams.get('feil'));
</script>

<div class="smal">
	<h1>Logg inn</h1>
	<p class="svak">{data.organisasjon}</p>

	{#if feilFraUrl}
		<div class="varsel varsel-feil" role="alert">{feilFraUrl}</div>
	{/if}
	{#if form?.feil}
		<div class="varsel varsel-feil" role="alert">{form.feil}</div>
	{/if}

	{#if data.helseId}
		<div class="kort">
			<h2>HelseID</h2>
			<p class="svak">
				Logg inn med HelseID. Du blir sendt til Norsk helsenett for autentisering på
				sikkerhetsnivå 4.
			</p>
			<a class="knapp knapp-primar" href="/logg-inn/helseid?retur={encodeURIComponent(data.retur)}">
				Logg inn med HelseID
			</a>
		</div>
	{/if}

	{#if data.testinnlogging}
		<div class="kort">
			<h2>{data.helseId ? 'Lokal pålogging (test)' : 'Pålogging'}</h2>
			{#if data.helseId}
				<p class="svak">Kun for testmiljø. Skal være avslått i produksjon.</p>
			{/if}

			<form method="POST">
				<input type="hidden" name="retur" value={data.retur} />
				<div class="felt">
					<label for="brukernavn">Brukernavn</label>
					<input id="brukernavn" name="brukernavn" bind:value={brukernavn} autocomplete="username" required />
				</div>
				<div class="felt">
					<label for="passord">Passord</label>
					<input id="passord" name="passord" type="password" autocomplete="current-password" required />
				</div>
				{#if visEngangskode}
					<div class="felt">
						<label for="engangskode">Engangskode</label>
						<input
							id="engangskode"
							name="engangskode"
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern="[0-9]{'{'}6{'}'}"
							placeholder="000000"
						/>
						<small>Seks siffer fra autentiseringsappen din.</small>
					</div>
				{/if}
				<button type="submit" class="primar">Logg inn</button>
			</form>

			{#if data.demobrukere.length}
				<hr />
				<h3>Demobrukere</h3>
				<p class="svak">Passord for alle: <span class="mono">Testpassord1!</span> · engangskode: <span class="mono">000000</span></p>
				<div class="tabell-omslag">
					<table>
						<thead><tr><th>Brukernavn</th><th>Navn</th><th>Rolle</th></tr></thead>
						<tbody>
							{#each data.demobrukere as d (d.brukernavn)}
								<tr>
									<td><button type="button" class="liten diskret mono" onclick={() => (brukernavn = d.brukernavn)}>{d.brukernavn}</button></td>
									<td>{d.navn}</td>
									<td>{d.rolle}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{:else if !data.helseId}
		<div class="varsel varsel-feil">
			Ingen påloggingsmetode er konfigurert. Kontakt systemansvarlig.
		</div>
	{/if}
</div>
