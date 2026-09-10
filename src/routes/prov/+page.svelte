<script lang="ts">
	let { data, form } = $props();
	const was = (f: string) =>
		(form as { values?: Record<string, string> } | null)?.values?.[f] ?? '';
</script>

<div class="paloggingsside">
	<h1>Prøv EPJ</h1>
	<p class="svak">
		Du får ditt eget legekontor i journalen, med deg selv som systemansvarlig. Det tar under et
		minutt, og du logger inn med en kode på e-post.
	</p>

	{#if form?.error}
		<div class="varsel varsel-feil" role="alert">{form.error}</div>
	{/if}

	<div class="kort">
		<form method="POST">
			<div class="felt">
				<label for="navn">Navn</label>
				<input id="navn" name="navn" required autocomplete="name" value={was('navn')} />
			</div>
			<div class="felt">
				<label for="epost">E-post</label>
				<input id="epost" name="epost" type="email" required autocomplete="email" value={was('epost')} />
				<small class="svak">Hit sender vi påloggingskoden.</small>
			</div>
			<div class="felt">
				<label for="virksomhet">Navn på kontoret</label>
				<input id="virksomhet" name="virksomhet" required value={was('virksomhet')} placeholder="Storgata Legesenter" />
			</div>
			{#if data.addresses.length > 1}
				<div class="felt">
					<label for="adresse">Adresse</label>
					<select id="adresse" name="adresse">
						{#each data.addresses as a (a.hostname)}
							<option value={a.hostname} selected={a.hostname === data.here}>{a.hostname}</option>
						{/each}
					</select>
					<small class="svak">
						Adressen deles med andre virksomheter. Hvilken journal du havner i, følger av hvem
						som er innlogget – ikke av adressen.
					</small>
				</div>
			{/if}

			<div class="felt">
				<label for="fodselsnummer">Fødselsnummer <span class="svak">(valgfritt)</span></label>
				<input id="fodselsnummer" name="fodselsnummer" inputmode="numeric" value={was('fodselsnummer')} />
				<small class="svak">
					Oppgir du det, kan du logge inn med HelseID i tillegg til e-postkoden – og prøve
					journalen slik en behandler faktisk kommer inn i den.
				</small>
			</div>

			<button type="submit" class="primar">Opprett prøvekonto</button>
		</form>
	</div>

	<div class="varsel varsel-advarsel">
		<strong>Bare syntetiske data.</strong>
		En prøvekonto er en ekte journal med ekte tilgangskontroll, men uten HelseID og uten
		databehandleravtale. Legg aldri inn opplysninger om virkelige personer.
	</div>
</div>
