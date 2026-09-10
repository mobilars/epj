<script lang="ts">
	import { page } from '$app/state';
	let { data, form } = $props();

	// The form works without JavaScript: the one-time code field is always there,
	// and the username is filled in server-side after a failed attempt.
	const errorFromUrl = $derived(page.url.searchParams.get('feil'));
</script>

<div class="smal">
	<h1>Logg inn</h1>
	<p class="svak">{data.organisation}</p>

	{#if errorFromUrl}
		<div class="varsel varsel-feil" role="alert">{errorFromUrl}</div>
	{/if}
	{#if form?.error}
		<div class="varsel varsel-feil" role="alert">{form.error}</div>
	{/if}

	{#if data.healthId}
		<div class="kort">
			<h2>HelseID</h2>
			<p class="svak">
				Logg inn med HelseID. Du blir sendt til Norsk helsenett for autentisering på
				sikkerhetsnivå 4.
			</p>
			<a class="knapp knapp-primar" href="/logg-inn/helseid?retur={encodeURIComponent(data.returnTo)}">
				Logg inn med HelseID
			</a>
		</div>
	{/if}

	{#if data.testLogin}
		<div class="kort">
			<h2>{data.healthId ? 'Lokal pålogging (test)' : 'Pålogging'}</h2>
			{#if data.healthId}
				<p class="svak">Kun for testmiljø. Skal være avslått i produksjon.</p>
			{/if}

			<form method="POST">
				<input type="hidden" name="retur" value={data.returnTo} />
				<div class="felt">
					<label for="brukernavn">Brukernavn</label>
					<!-- Feltet fylles bevisst ikke ut på nytt etter et mislykket forsøk:
					     en reaktiv verdi på et input-felt overskriver det brukeren
					     rekker å taste før siden er ferdig hydrert. -->
					<input id="brukernavn" name="brukernavn" autocomplete="username" required />
				</div>
				<div class="felt">
					<label for="passord">Passord</label>
					<input id="passord" name="passord" type="password" autocomplete="current-password" required />
				</div>
				<div class="felt">
					<label for="engangskode">Engangskode</label>
					<input
						id="engangskode"
						name="engangskode"
						inputmode="numeric"
						autocomplete="one-time-code"
						placeholder="000000"
					/>
					<small>Seks siffer fra autentiseringsappen din.</small>
				</div>
				<button type="submit" class="primar">Logg inn</button>
			</form>

			{#if data.demoUsers.length}
				<hr />
				<h3>Demobrukere</h3>
				<p class="svak">Passord for alle: <span class="mono">Testpassord1!</span> · engangskode: <span class="mono">000000</span></p>
				<div class="tabell-omslag">
					<table>
						<thead><tr><th>Brukernavn</th><th>Navn</th><th>Rolle</th></tr></thead>
						<tbody>
							{#each data.demoUsers as d (d.username)}
								<tr>
									<td class="mono">{d.username}</td>
									<td>{d.name}</td>
									<td>{d.role}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{:else if !data.healthId}
		<div class="varsel varsel-feil">
			Ingen påloggingsmetode er konfigurert. Kontakt systemansvarlig.
		</div>
	{/if}
</div>
