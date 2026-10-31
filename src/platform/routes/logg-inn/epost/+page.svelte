<script lang="ts">
	let { data, form } = $props();
	const sent = $derived(form?.sent ?? data.sent);
	const email = $derived(form?.email ?? data.email);
</script>

<div class="paloggingsside">
	<h1>Logg inn med e-post</h1>
	<p class="svak">{data.organisation}</p>

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
				{#if form?.accounts?.length}
					<div class="felt">
						<label for="virksomhet">Virksomhet</label>
						<select id="virksomhet" name="virksomhet">
							{#each form.accounts as a (a.tenantId)}
								<option value={a.tenantId}>{a.tenantName}</option>
							{/each}
						</select>
						<small class="svak">Adressen din har konto flere steder.</small>
					</div>
				{/if}
				<div class="felt">
					<label for="kode">Kode</label>
					<input id="kode" name="kode" inputmode="numeric" autocomplete="one-time-code" required
						value={form?.code ?? ''} />
				</div>
				<button type="submit" class="primar">Logg inn</button>
			</form>
			<p class="svak liten"><a href="/logg-inn/epost">Send en ny kode</a></p>
		</div>
	{:else}
		<div class="kort">
			<form method="POST" action="?/send">
				<div class="felt">
					<label for="epost">E-post</label>
					<input id="epost" name="epost" type="email" autocomplete="email" required value={email} />
				</div>
				<button type="submit" class="primar">Send kode</button>
			</form>
			<p class="svak liten">
				Helsepersonell logger inn med <a href="/logg-inn">HelseID</a>.
			</p>
		</div>
	{/if}
</div>
