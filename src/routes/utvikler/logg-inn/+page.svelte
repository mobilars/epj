<script lang="ts">
	let { data, form } = $props();

	const sent = $derived(form?.sent ?? data.sent);
	const email = $derived(form?.email ?? data.email);
</script>

<div class="paloggingsside">
	<h1>Utviklerportal</h1>
	<p class="svak">
		Registrer og forvalt SMART on FHIR-apper for journalen. Ingen pasientopplysninger er
		tilgjengelige her.
	</p>

	{#if form?.error}
		<div class="varsel varsel-feil" role="alert">{form.error}</div>
	{/if}

	{#if sent}
		<div class="kort">
			<h2>Skriv inn koden</h2>
			<p class="svak">
				Vi har sendt en sekssifret kode til <span class="mono">{email}</span>. Den er gyldig i
				femten minutter.
			</p>
			<form method="POST" action="?/bekreft">
				<input type="hidden" name="epost" value={email} />
				<div class="felt">
					<label for="kode">Kode</label>
					<input id="kode" name="kode" inputmode="numeric" autocomplete="one-time-code" required />
				</div>
				<button type="submit" class="primar">Logg inn</button>
			</form>
			<p class="svak liten">
				<a href="/utvikler/logg-inn">Send en ny kode</a>
			</p>
		</div>
	{:else}
		<div class="kort">
			<h2>Logg inn</h2>
			<p class="svak">
				Skriv inn e-postadressen din, så sender vi en engangskode. Har du ikke konto fra før,
				opprettes den ved første pålogging.
			</p>
			<form method="POST" action="?/send">
				<div class="felt">
					<label for="epost">E-post</label>
					<input id="epost" name="epost" type="email" autocomplete="email" required value={email} />
				</div>
				<button type="submit" class="primar">Send kode</button>
			</form>
		</div>
	{/if}
</div>
