<script lang="ts">
	let { data, form } = $props();
	let extent = $state('alle');
	const active = $derived(data.restrictions.filter((r: { lifted: boolean }) => !r.lifted));
	const lifted = $derived(data.restrictions.filter((r: { lifted: boolean }) => r.lifted));
</script>

<h1>Sperring av journalen</h1>

<p class="svak">
	Pasienten kan motsette seg at bestemte helsepersonell, eller alle, får tilgang til journalen
	(pasientjournalloven § 17, helsepersonelloven § 25). Sperringen registreres her etter pasientens
	ønske, og oppheves bare når pasienten ber om det. Den som er sperret ute får bare tilgang ved
	nødrett, og oppslaget blir da logget særskilt og gjennomgått.
</p>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}

<section class="kort">
	<h2>Aktive sperringer</h2>
	{#each active as r (r.id)}
		<div class="sperring">
			<div class="rad-mellom">
				<strong>{r.what}</strong>
				<span class="svak liten">
					{r.registeredAt} · {r.registeredBy}{#if r.validUntil}&nbsp;· til {r.validUntil}{/if}
				</span>
			</div>
			<p>{r.justification}</p>
			<details>
				<summary>Opphev sperringen</summary>
				<form method="POST" action="?/lift">
					<input type="hidden" name="id" value={r.id} />
					<div class="felt">
						<label for="opphev-{r.id}">Hvorfor oppheves sperringen?</label>
						<input
							id="opphev-{r.id}"
							name="begrunnelse"
							required
							minlength="10"
							placeholder="Pasienten ba om det den …"
						/>
					</div>
					<button type="submit" class="liten fare">Opphev</button>
				</form>
			</details>
		</div>
	{:else}
		<p class="svak">Journalen har ingen sperringer.</p>
	{/each}
</section>

<section class="kort">
	<h2>Registrer ny sperring</h2>
	<form method="POST" action="?/register">
		<fieldset class="felt">
			<legend>Hvem skal sperres ute?</legend>
			<label>
				<input type="radio" name="omfang" value="alle" bind:group={extent} />
				Alle — journalen åpnes bare ved nødrett
			</label>
			<label><input type="radio" name="omfang" value="bruker" bind:group={extent} /> En bestemt bruker</label>
			<label><input type="radio" name="omfang" value="rolle" bind:group={extent} /> Alle med en bestemt rolle</label>
		</fieldset>
		{#if extent === 'bruker'}
			<div class="felt">
				<label for="bruker">Bruker</label>
				<select id="bruker" name="bruker" required>
					<option value="">Velg …</option>
					{#each data.users as u (u.id)}<option value={u.id}>{u.name}</option>{/each}
				</select>
			</div>
		{:else if extent === 'rolle'}
			<div class="felt">
				<label for="rolle">Rolle</label>
				<select id="rolle" name="rolle" required>
					<option value="">Velg …</option>
					{#each data.roles as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
				</select>
			</div>
		{/if}
		<div class="felt">
			<label for="begrunnelse">Hva har pasienten bedt om?</label>
			<textarea
				id="begrunnelse"
				name="begrunnelse"
				rows="3"
				required
				minlength="10"
				placeholder="Pasienten ønsker ikke at … skal ha tilgang, fordi …"
			></textarea>
		</div>
		<div class="felt">
			<label for="gyldigTil">Gyldig til (valgfritt)</label>
			<input id="gyldigTil" name="gyldigTil" type="date" />
		</div>
		<button type="submit" class="primar">Registrer sperring</button>
	</form>
</section>

{#if lifted.length > 0}
	<section class="kort">
		<h2>Opphevede sperringer</h2>
		<ul>
			{#each lifted as r (r.id)}
				<li class="svak">{r.what} — registrert {r.registeredAt} av {r.registeredBy}</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.sperring + .sperring {
		border-top: 1px solid var(--kant);
		margin-top: 0.75rem;
		padding-top: 0.75rem;
	}
	fieldset label {
		display: block;
		margin: 0.25rem 0;
	}
</style>
