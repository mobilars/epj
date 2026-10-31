<script lang="ts">
	let { data, form } = $props();
</script>

<div class="paloggingsside">
	<h1>Sett opp totrinnsverifisering</h1>
	<p class="svak">Kontoen <span class="mono">{data.username}</span> mangler autentiseringsapp.</p>

	<div class="kort">
		{#if form?.error}
			<div class="varsel varsel-feil" role="alert">{form.error}</div>
		{/if}

		<p>
			Legg hemmeligheten inn i en autentiseringsapp – for eksempel Google Authenticator, Microsoft
			Authenticator eller 1Password – og skriv inn koden appen viser.
		</p>

		<div class="felt">
			<label for="hemmelighet">Hemmelighet</label>
			<input id="hemmelighet" class="mono" value={data.secret} readonly />
			<small class="svak">Velg «skriv inn nøkkel manuelt» i appen, og lim inn denne.</small>
		</div>

		<p><a href={data.otpauth}>Åpne i autentiseringsappen</a></p>

		<form method="POST">
			<div class="felt">
				<label for="engangskode">Kode fra appen</label>
				<input
					id="engangskode"
					name="engangskode"
					inputmode="numeric"
					autocomplete="one-time-code"
					placeholder="6 siffer"
					required
				/>
			</div>
			<button type="submit" class="primar">Fullfør oppsettet</button>
		</form>
	</div>
</div>
