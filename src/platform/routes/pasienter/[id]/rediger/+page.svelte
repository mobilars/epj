<script lang="ts">
	let { data, form } = $props();

	// What was posted wins over what is stored, so a refused save loses nothing.
	const value = (name: string) => form?.values?.[name] ?? data.values[name] ?? '';
</script>

<h2>Pasientopplysninger</h2>

<form method="POST" class="kort">
	{#if form?.error}
		<div class="varsel varsel-feil" role="alert">
			{form.error}
			{#if form.duplicate}
				<a href="/pasienter/{form.duplicate.id}">Åpne journalen til {form.duplicate.name}</a>
			{/if}
		</div>
	{/if}

	<!-- The number failed its check digits. Said plainly, with what saving it
	     anyway means, and saved only when the box is ticked. -->
	{#if form?.confirmIdentity}
		<div class="varsel varsel-advarsel" role="alert">
			<p><strong>Ugyldig fødselsnummer.</strong> {form.confirmIdentity}</p>
			<label class="avkryssing">
				<input type="checkbox" name="bekreftUgyldig" value="ja" />
				Lagre med dette nummeret likevel
			</label>
			<small>Eller rett nummeret under og lagre på nytt.</small>
		</div>
	{:else if data.unverified}
		<div class="varsel varsel-advarsel" role="status">
			Nummeret som står på pasienten er ikke et gyldig fødselsnummer. Det brukes ikke mot Helfo,
			reseptformidleren eller i meldinger før det er rettet.
		</div>
	{/if}

	<div class="rad">
		<div class="felt" style="flex: 1 1 220px">
			<label for="fornavn">Fornavn</label>
			<input id="fornavn" name="fornavn" required autocomplete="off" value={value('fornavn')} />
		</div>
		<div class="felt" style="flex: 1 1 220px">
			<label for="etternavn">Etternavn</label>
			<input id="etternavn" name="etternavn" required autocomplete="off" value={value('etternavn')} />
		</div>
	</div>

	<div class="rad">
		<div class="felt" style="flex: 1 1 220px">
			<label for="fodselsnummer">Fødselsnummer eller D-nummer</label>
			<input id="fodselsnummer" name="fodselsnummer" inputmode="numeric" required autocomplete="off" value={value('fodselsnummer')} />
			<small class="svak">Elleve siffer.</small>
		</div>
		<div class="felt" style="flex: 0 1 180px">
			<label for="fodselsdato">Fødselsdato</label>
			<input id="fodselsdato" name="fodselsdato" type="date" value={value('fodselsdato')} />
		</div>
		<div class="felt" style="flex: 0 1 160px">
			<label for="kjonn">Kjønn</label>
			<select id="kjonn" name="kjonn">
				<option value="" selected={!value('kjonn')}>Fra nummeret</option>
				<option value="female" selected={value('kjonn') === 'female'}>Kvinne</option>
				<option value="male" selected={value('kjonn') === 'male'}>Mann</option>
				<option value="other" selected={value('kjonn') === 'other'}>Annet</option>
				<option value="unknown" selected={value('kjonn') === 'unknown'}>Ukjent</option>
			</select>
		</div>
	</div>
	<small class="svak">
		Står fødselsdato eller kjønn tomt, hentes de fra fødselsnummeret når det er gyldig.
	</small>

	<div class="rad">
		<div class="felt" style="flex: 1 1 200px">
			<label for="telefon">Telefon</label>
			<input id="telefon" name="telefon" inputmode="tel" autocomplete="off" value={value('telefon')} />
		</div>
		<div class="felt" style="flex: 1 1 260px">
			<label for="epost">E-post</label>
			<input id="epost" name="epost" type="email" autocomplete="off" value={value('epost')} />
		</div>
	</div>

	<div class="felt">
		<label for="adresse">Adresse</label>
		<input id="adresse" name="adresse" autocomplete="off" value={value('adresse')} />
	</div>

	<div class="rad">
		<div class="felt" style="flex: 0 1 140px">
			<label for="postnummer">Postnummer</label>
			<input id="postnummer" name="postnummer" inputmode="numeric" autocomplete="off" value={value('postnummer')} />
		</div>
		<div class="felt" style="flex: 1 1 220px">
			<label for="poststed">Poststed</label>
			<input id="poststed" name="poststed" autocomplete="off" value={value('poststed')} />
		</div>
	</div>

	<div class="rad">
		<button type="submit" class="primar">Lagre</button>
		<a class="knapp" href="/pasienter/{data.patientId}">Avbryt</a>
	</div>

	<small class="svak">
		Endringen loggføres. Den forrige utgaven av opplysningene blir tatt vare på.
	</small>
</form>
