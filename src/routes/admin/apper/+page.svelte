<script lang="ts">
	let { data, form } = $props();

</script>

<div class="rad-mellom">
	<h2>SMART-apper og tjenester</h2>
</div>

<div class="varsel varsel-info">
	FHIR-endepunkt: <span class="mono">{data.fhirBaseUrl}</span><br />
	Oppsettdokument: <a href={data.wellKnown} class="mono">/.well-known/smart-configuration</a>
</div>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.clientId}
	<div class="varsel varsel-ok" role="status">
		Registrert. <span class="mono">client_id: {form.clientId}</span>
		{#if form.secret}<br />Klienthemmelighet (vises kun nå): <strong class="mono">{form.secret}</strong>{/if}
	</div>
{/if}
{#if form?.launchId}
	<div class="varsel varsel-info">
		Launch-kontekst opprettet: <span class="mono">{form.launchId}</span>. Appen må åpnes med
		<span class="mono">iss</span> og <span class="mono">launch</span> som parametre.
	</div>
{/if}

<section class="kort">
	<h3>Registrer app</h3>
	<form method="POST" action="?/registrer">
		<div class="rad">
			<div style="flex:1 1 14rem"><label for="navn">Navn</label><input id="navn" name="navn" required /></div>
			<div style="flex:0 0 12rem">
				<label for="kategori">Type</label>
				<select id="kategori" name="kategori">
					<option value="smart-ehr">SMART, startet fra journalen</option>
					<option value="smart-standalone">SMART, selvstendig</option>
					<option value="backend">Backend-tjeneste</option>
				</select>
			</div>
			<div style="flex:0 0 12rem">
				<label for="type">Klienttype</label>
				<select id="type" name="type"><option value="public">Offentlig (PKCE)</option><option value="confidential">Konfidensiell</option></select>
			</div>
		</div>
		<div class="felt">
			<label for="redirectUris">Redirect-URI-er</label>
			<textarea id="redirectUris" name="redirectUris" placeholder="https://app.example/callback" style="min-height:4rem"></textarea>
			<small>Én per linje. Sammenliknes eksakt.</small>
		</div>
		<div class="felt">
			<label for="scopes">Tillatte scope</label>
			<textarea id="scopes" name="scopes" placeholder="openid fhirUser launch launch/patient patient/Patient.rs" style="min-height:4rem"></textarea>
			<small>Appen kan aldri få mer enn dette, og aldri mer enn brukerens rolle tillater.</small>
		</div>
		<div class="rad">
			<div style="flex:1 1 16rem"><label for="jwksUri">jwks_uri</label><input id="jwksUri" name="jwksUri" placeholder="https://app.example/jwks.json" /></div>
			<div style="flex:1 1 12rem"><label for="databehandleravtale">Databehandleravtale</label><input id="databehandleravtale" name="databehandleravtale" placeholder="DBA-2026-001" /></div>
		</div>
		<div class="rad">
			<div style="flex:1 1 18rem"><label for="launchUrl">Launch-URL (EHR launch)</label><input id="launchUrl" name="launchUrl" placeholder="https://app.example/launch" /></div>
		</div>
		<div class="felt"><label for="jwks">JWKS (JSON)</label><textarea id="jwks" name="jwks" placeholder={'{"keys":[...]}'}></textarea></div>
		<button type="submit" class="primar">Registrer</button>
	</form>
</section>

{#each data.apper as a (a.clientId)}
	<article class="kort">
		<div class="rad-mellom">
			<h3>{a.name}</h3>
			<span class="rad">
				<span class="merke">{a.category}</span>
				<span class="merke">{a.type}</span>
				<span class="merke" class:merke-ok={a.status === 'aktiv'} class:merke-fare={a.status !== 'aktiv'}>{a.status}</span>
			</span>
		</div>
		<p class="mono svak">{a.clientId}</p>
		{#if !a.databehandleravtale}
			<div class="varsel varsel-advarsel">Ingen databehandleravtale registrert.</div>
		{:else}
			<p class="svak">Databehandleravtale: {a.databehandleravtale}</p>
		{/if}
		<p class="svak">
			Registrert {a.created_at} · {a.aktiveTokens} aktive tokens
			{#if a.hasKeys}· asymmetrisk klientautentisering{/if}
		</p>
		{#if a.redirectUris.length}
			<p class="svak mono">{a.redirectUris.join(' ')}</p>
		{/if}
		<details>
			<summary>Tillatte tilganger ({a.scopes.length})</summary>
			<ul>{#each a.scopes as s (s.scope)}<li><span class="mono">{s.scope}</span> — {s.description}</li>{/each}</ul>
		</details>
		<div class="rad">
			<form method="POST" action="?/status">
				<input type="hidden" name="clientId" value={a.clientId} />
				<input type="hidden" name="status" value={a.status === 'aktiv' ? 'sperret' : 'aktiv'} />
				<button type="submit" class="liten" class:fare={a.status === 'aktiv'}>
					{a.status === 'aktiv' ? 'Sperr appen og trekk tilbake tokens' : 'Aktiver'}
				</button>
			</form>
			{#if a.category !== 'backend'}
				<form method="POST" action="?/testlaunch" class="rad">
					<input type="hidden" name="clientId" value={a.clientId} />
					<input name="patientId" placeholder="Pasient-id" style="width:14rem" />
					<button type="submit" class="liten">Lag launch-kontekst</button>
				</form>
			{/if}
		</div>
	</article>
{/each}
