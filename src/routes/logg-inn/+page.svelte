<script lang="ts">
	import { page } from '$app/state';
	let { data, form } = $props();

	// The form works without JavaScript: the one-time code field is always there,
	// and the username is filled in server-side after a failed attempt.
	const errorFromUrl = $derived(page.url.searchParams.get('feil'));

	let usernameField = $state<HTMLInputElement>();
	let passwordField = $state<HTMLInputElement>();
	let oneTimeCodeField = $state<HTMLInputElement>();
	let filling = $state('');

	/**
	 * Fills the form for a demo account.
	 *
	 * The one-time code is fetched rather than rendered with the page: it is
	 * valid for half a minute, so a code from page load would usually be stale
	 * by the time anyone clicked. Without JavaScript the account details are
	 * still listed, and the code can be produced from the TOTP secret below.
	 */
	async function fillIn(username: string) {
		filling = username;
		if (!usernameField || !passwordField || !oneTimeCodeField) return;
		usernameField.value = username;
		passwordField.value = data.demoPassword;
		try {
			const response = await fetch(`/logg-inn/demokode?brukernavn=${encodeURIComponent(username)}`);
			if (response.ok) oneTimeCodeField.value = (await response.json()).code;
		} catch {
			/* leave the code field to the user */
		}
		filling = '';
		if (oneTimeCodeField.value) passwordField.form?.requestSubmit();
		else oneTimeCodeField.focus();
	}
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
					<input id="brukernavn" name="brukernavn" autocomplete="username" required bind:this={usernameField} />
				</div>
				<div class="felt">
					<label for="passord">Passord</label>
					<input
						id="passord"
						name="passord"
						type="password"
						autocomplete="current-password"
						required
						bind:this={passwordField}
					/>
				</div>
				<div class="felt">
					<label for="engangskode">Engangskode</label>
					<input
						id="engangskode"
						name="engangskode"
						inputmode="numeric"
						autocomplete="one-time-code"
						placeholder="6 siffer"
						bind:this={oneTimeCodeField}
					/>
					<small>Seks siffer fra autentiseringsappen din.</small>
				</div>
				<button type="submit" class="primar">Logg inn</button>
			</form>

			{#if data.demoUsers.length}
				<hr />
				<h3>Demobrukere</h3>
				<p class="svak">
					Trykk på en bruker for å logge inn som den. Passord for alle:
					<span class="mono">{data.demoPassword}</span>. Engangskoden er en TOTP-kode, ikke et
					fast tall - den regnes ut fra hemmeligheten
					<span class="mono">{data.demoTotpSecret}</span>, som kan legges inn i en
					autentiseringsapp.
				</p>
				<div class="tabell-omslag">
					<table>
						<thead><tr><th>Brukernavn</th><th>Navn</th><th>Rolle</th><th></th></tr></thead>
						<tbody>
							{#each data.demoUsers as d (d.username)}
								<tr>
									<td class="mono">{d.username}</td>
									<td>{d.name}</td>
									<td>{d.role}</td>
									<td>
										<button
											type="button"
											class="liten"
											disabled={filling !== ''}
											onclick={() => fillIn(d.username)}
										>
											{filling === d.username ? 'Logger inn …' : 'Logg inn'}
										</button>
									</td>
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
