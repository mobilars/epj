<script lang="ts">
	let { data, form } = $props();

	const value = (name: string, fallback = '') => form?.values?.[name] ?? fallback;
</script>

<h1>Registrer pasient</h1>

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
			<div class="rad">
				<div class="felt" style="flex: 0 1 200px">
					<label for="fodselsdato">Fødselsdato</label>
					<input id="fodselsdato" name="fodselsdato" type="date" value={value('fodselsdato')} />
				</div>
				<div class="felt" style="flex: 0 1 200px">
					<label for="kjonn">Kjønn</label>
					<select id="kjonn" name="kjonn">
						<option value="" selected={!value('kjonn')}>Ikke oppgitt</option>
						<option value="female" selected={value('kjonn') === 'female'}>Kvinne</option>
						<option value="male" selected={value('kjonn') === 'male'}>Mann</option>
						<option value="other" selected={value('kjonn') === 'other'}>Annet</option>
					</select>
				</div>
			</div>
			<small>Fødselsdato og kjønn kan ikke leses ut av et ugyldig nummer. Fyll dem inn her om du vil.</small>
			<label class="avkryssing">
				<input type="checkbox" name="bekreftUgyldig" value="ja" />
				Lagre pasienten med dette nummeret likevel
			</label>
			<small>Eller rett nummeret under og registrer på nytt.</small>
		</div>
	{/if}

	<div class="felt">
		<label for="fodselsnummer">Fødselsnummer eller D-nummer</label>
		<input
			id="fodselsnummer"
			name="fodselsnummer"
			inputmode="numeric"
			required
			autocomplete="off"
			value={value('fodselsnummer', data.nationalId)}
		/>
		<small class="svak">Elleve siffer. Fødselsdato og kjønn hentes fra nummeret.</small>
	</div>

	<div class="rad">
		<div class="felt" style="flex: 1 1 220px">
			<label for="fornavn">Fornavn</label>
			<input id="fornavn" name="fornavn" required autocomplete="off" value={value('fornavn', data.name)} />
		</div>
		<div class="felt" style="flex: 1 1 220px">
			<label for="etternavn">Etternavn</label>
			<input id="etternavn" name="etternavn" required autocomplete="off" value={value('etternavn')} />
		</div>
	</div>

	<div class="felt">
		<label for="telefon">Telefon</label>
		<input id="telefon" name="telefon" inputmode="tel" autocomplete="off" value={value('telefon')} />
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
		<button type="submit" class="primar">Registrer pasient</button>
		<a class="knapp" href="/pasienter">Avbryt</a>
	</div>

	<small class="svak">
		Registreringen loggføres, og du får behandlingsrelasjon til pasienten slik at du kan åpne
		journalen etterpå.
	</small>
</form>
