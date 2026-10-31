<script lang="ts">
	let { data, form } = $props();

	const was = (field: string) =>
		(form as { values?: Record<string, string> } | null)?.values?.[field] ?? '';
</script>

<div class="rad-mellom">
	<h2>Brukere i {data.organisation.name}</h2>
	<a href="/systemadmin/{data.organisation.id}">← Virksomheten</a>
</div>

<p class="svak">
	Plattformadministrasjon ser hvem som kan logge inn og med hvilken rolle – aldri
	pasientopplysninger. Endringene her loggføres i virksomhetens egen logg, merket som gjort fra
	plattformen.
</p>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}
{#if form?.temporaryPassword}
	<div class="varsel varsel-ok" role="status">
		Midlertidig passord for <strong>{form.username}</strong>:
		<span class="mono">{form.temporaryPassword}</span><br />
		Vises bare nå. Brukeren må bytte det ved første pålogging, og setter opp
		totrinnsverifisering samtidig.
	</div>
{/if}

<section class="kort">
	<h3>Ny bruker</h3>
	<form method="POST" action="?/create">
		<div class="feltrad">
			<div style="flex:0 1 12rem">
				<label for="brukernavn">Brukernavn</label>
				<input id="brukernavn" name="brukernavn" required value={was('brukernavn')} />
			</div>
			<div style="flex:1 1 14rem">
				<label for="navn">Navn</label>
				<input id="navn" name="navn" value={was('navn')} />
			</div>
			<div style="flex:0 1 10rem">
				<label for="hpr">HPR-nummer</label>
				<input id="hpr" name="hpr" inputmode="numeric" value={was('hpr')} />
			</div>
			<div style="flex:0 1 12rem">
				<label for="fodselsnummer">Fødselsnummer</label>
				<input id="fodselsnummer" name="fodselsnummer" inputmode="numeric" value={was('fodselsnummer')} />
				<small class="svak">Gjør at brukeren kan logge inn med HelseID.</small>
			</div>
		</div>
		<fieldset>
			<legend>Roller</legend>
			{#each data.roles as r (r.code)}
				<label class="avkryssing">
					<input type="checkbox" name="roller" value={r.code} />
					<strong>{r.name}</strong>
					<span class="svak">{r.description}</span>
				</label>
			{/each}
		</fieldset>
		<button type="submit" class="primar">Opprett bruker</button>
	</form>
</section>

<section class="kort">
	<h3>Brukere ({data.users.length})</h3>
	{#each data.users as u (u.id)}
		<div class="kort">
			<div class="rad-mellom">
				<div>
					<strong>{u.name}</strong>
					<span class="mono">{u.username}</span>
					{#if u.hpr}<span class="svak">HPR {u.hpr}</span>{/if}
				</div>
				<div>
					<span class="merke" class:merke-ok={u.status === 'aktiv'} class:merke-fare={u.status !== 'aktiv'}>
						{u.status}
					</span>
					{#if !u.mfa}<span class="merke merke-advarsel">Uten totrinn</span>{/if}
				</div>
			</div>
			<p class="svak">
				Roller: {u.roles.join(', ') || 'ingen'}
				{#if u.lastLogin}· sist innlogget {u.lastLogin}{/if}
			</p>

			<details>
				<summary>Endre roller</summary>
				<form method="POST" action="?/roles">
					<input type="hidden" name="id" value={u.id} />
					{#each data.roles as r (r.code)}
						<label class="avkryssing">
							<input type="checkbox" name="roller" value={r.code} checked={u.roles.includes(r.code)} />
							{r.name}
						</label>
					{/each}
					<button type="submit" class="liten">Lagre roller</button>
				</form>
			</details>

			<div class="rad">
				<form method="POST" action="?/newPassword">
					<input type="hidden" name="id" value={u.id} />
					<input type="hidden" name="brukernavn" value={u.username} />
					<button type="submit" class="liten">Nytt midlertidig passord</button>
				</form>
				{#if u.mfa}
					<form method="POST" action="?/nullstillMfa">
						<input type="hidden" name="id" value={u.id} />
						<button type="submit" class="liten">Nullstill totrinnsverifisering</button>
					</form>
				{/if}
				<form method="POST" action="?/status">
					<input type="hidden" name="id" value={u.id} />
					<input type="hidden" name="status" value={u.status === 'aktiv' ? 'sperret' : 'aktiv'} />
					<button type="submit" class="liten" class:fare={u.status === 'aktiv'}>
						{u.status === 'aktiv' ? 'Sperr' : 'Aktiver'}
					</button>
				</form>
			</div>
		</div>
	{/each}
</section>
