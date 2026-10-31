<script lang="ts">
	let { data, form } = $props();

	const merke = (status: string) =>
		status === 'godkjent' ? 'merke-ok' : status === 'avvist' ? 'merke-fare' : status === 'til-vurdering' ? 'merke-advarsel' : '';
</script>

<div class="rad-mellom">
	<h1>Mine apper</h1>
	<span class="svak">{data.profile.email}</span>
</div>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}

<details class="kort">
	<summary>Profil</summary>
	<form method="POST" action="?/profil">
		<div class="feltrad">
			<div style="flex:1 1 14rem">
				<label for="navn">Navn</label>
				<input id="navn" name="navn" value={data.profile.name} />
			</div>
			<div style="flex:1 1 14rem">
				<label for="virksomhet">Virksomhet</label>
				<input id="virksomhet" name="virksomhet" value={data.profile.organisation} />
			</div>
		</div>
		<button type="submit" class="liten">Lagre profil</button>
	</form>
</details>

{#each data.apps as app (app.id)}
	<section class="kort">
		<div class="rad-mellom">
			<h2>{app.name}</h2>
			<span class="merke {merke(app.status)}">{app.statusText}</span>
		</div>
		{#if app.summary}<p class="svak">{app.summary}</p>{/if}

		{#if app.status === 'avvist' && app.reviewNote}
			<div class="varsel varsel-feil">
				<strong>Ikke godkjent.</strong>
				{app.reviewNote}
			</div>
		{:else if app.status === 'til-vurdering'}
			<p class="svak liten">Til vurdering hos plattformen. Du får svar på e-post.</p>
		{:else if app.status === 'godkjent'}
			<p class="svak liten">Godkjent, og kan installeres av virksomheter.</p>
		{/if}

		<details>
			<summary>Rediger</summary>
			<form method="POST" action="?/lagre">
				<input type="hidden" name="id" value={app.id} />
				<div class="feltrad">
					<div style="flex:1 1 14rem">
						<label for="navn-{app.id}">Navn</label>
						<input id="navn-{app.id}" name="navn" required value={app.name} />
					</div>
					<div style="flex:0 1 12rem">
						<label for="plassering-{app.id}">Plassering</label>
						<select id="plassering-{app.id}" name="plassering">
							<option value="ingen" selected={app.placement === 'ingen'}>Startes ved behov</option>
							<option value="hoved" selected={app.placement === 'hoved'}>Stor flate</option>
							<option value="side" selected={app.placement === 'side'}>Sidepanel</option>
						</select>
					</div>
				</div>
				<div class="felt">
					<label for="kort-{app.id}">Kort beskrivelse</label>
					<input id="kort-{app.id}" name="kortbeskrivelse" value={app.summary} />
				</div>
				<div class="felt">
					<label for="beskrivelse-{app.id}">Beskrivelse</label>
					<textarea id="beskrivelse-{app.id}" name="beskrivelse" rows="3">{app.description}</textarea>
				</div>
				<div class="felt">
					<label for="launch-{app.id}">Launch-URL</label>
					<input id="launch-{app.id}" name="launchUrl" required value={app.launchUrl} />
					<small class="svak">
						Skriv <span class="mono">{'{client_id}'}</span> der klient-id-en skal settes inn ved installasjon.
					</small>
				</div>
				<div class="felt">
					<label for="redirect-{app.id}">Redirect-URI-er</label>
					<textarea id="redirect-{app.id}" name="redirectUris" rows="2">{app.redirectUris.join('\n')}</textarea>
					<small class="svak">Én per linje. Sammenliknes eksakt.</small>
				</div>
				<div class="felt">
					<label for="scopes-{app.id}">Scopes</label>
					<textarea id="scopes-{app.id}" name="scopes" rows="2">{app.scopeText}</textarea>
					<small class="svak">Be om det minste appen trenger. Alt her blir vurdert.</small>
				</div>
				<div class="feltrad">
					<div style="flex:1 1 12rem">
						<label for="kontakt-{app.id}">Kontakt-e-post</label>
						<input id="kontakt-{app.id}" name="kontaktEpost" value={app.contactEmail} />
					</div>
					<div style="flex:1 1 12rem">
						<label for="personvern-{app.id}">Personvernerklæring</label>
						<input id="personvern-{app.id}" name="personvernUrl" value={app.privacyUrl} />
					</div>
				</div>
				<div class="felt">
					<label for="dba-{app.id}">Databehandleravtale</label>
					<input id="dba-{app.id}" name="databehandleravtale" value={app.databehandleravtale} />
					<small class="svak">Referanse til avtalen, om det finnes en.</small>
				</div>
				<button type="submit" class="liten">Lagre</button>
			</form>
		</details>

		{#if app.scopes.length}
			<details>
				<summary>Ber om {app.scopes.length} tilganger</summary>
				<ul>
					{#each app.scopes as s (s.scope)}
						<li><span class="mono">{s.scope}</span> — {s.description}</li>
					{/each}
				</ul>
			</details>
		{/if}

		{#if app.canSubmit}
			<form method="POST" action="?/send">
				<input type="hidden" name="id" value={app.id} />
				<button type="submit" class="primar liten">Send til vurdering</button>
			</form>
		{/if}
	</section>
{:else}
	<p class="svak">Du har ingen apper ennå.</p>
{/each}

<section class="kort">
	<h2>Ny app</h2>
	<form method="POST" action="?/nyApp">
		<div class="feltrad">
			<div style="flex:1 1 14rem">
				<label for="ny-navn">Navn</label>
				<input id="ny-navn" name="navn" required />
			</div>
			<div style="flex:0 1 12rem">
				<label for="ny-plassering">Plassering</label>
				<select id="ny-plassering" name="plassering">
					<option value="ingen">Startes ved behov</option>
					<option value="hoved">Stor flate</option>
					<option value="side">Sidepanel</option>
				</select>
			</div>
		</div>
		<div class="felt">
			<label for="ny-kort">Kort beskrivelse</label>
			<input id="ny-kort" name="kortbeskrivelse" placeholder="Én setning om hva appen gjør" />
		</div>
		<div class="felt">
			<label for="ny-launch">Launch-URL</label>
			<input id="ny-launch" name="launchUrl" required placeholder="https://app.example/launch?client_id={'{client_id}'}" />
		</div>
		<div class="felt">
			<label for="ny-redirect">Redirect-URI-er</label>
			<textarea id="ny-redirect" name="redirectUris" rows="2" placeholder="https://app.example/callback"></textarea>
		</div>
		<div class="felt">
			<label for="ny-scopes">Scopes</label>
			<textarea id="ny-scopes" name="scopes" rows="2" placeholder="openid fhirUser launch patient/Patient.rs"></textarea>
		</div>
		<button type="submit" class="primar">Opprett</button>
	</form>
</section>
