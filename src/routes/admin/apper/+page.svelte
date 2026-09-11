<script lang="ts">
	let { data, form } = $props();

</script>

<div class="rad-mellom">
	<h2>SMART-apper og tjenester</h2>
	<a class="knapp" href="/admin/apper/galleri">Appgalleri</a>
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
	<form method="POST" action="?/register">
		<div class="feltrad">
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
		<div class="feltrad">
			<div style="flex:1 1 16rem"><label for="jwksUri">jwks_uri</label><input id="jwksUri" name="jwksUri" placeholder="https://app.example/jwks.json" /></div>
			<div style="flex:1 1 12rem"><label for="databehandleravtale">Databehandleravtale</label><input id="databehandleravtale" name="databehandleravtale" placeholder="DBA-2026-001" /></div>
		</div>
		<div class="feltrad">
			<div style="flex:1 1 18rem"><label for="launchUrl">Launch-URL (EHR launch)</label><input id="launchUrl" name="launchUrl" placeholder="https://app.example/launch" /></div>
		</div>
		<label class="avkryssing">
			<input type="checkbox" name="iHovedmeny" value="ja" />
			Vis appen i hovedmenyen — for apper som virker på tvers av pasienter og startes uten pasient (ellers under pasientens «Apper»)
		</label>
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
				{#if a.inMainMenu}<span class="merke merke-info">I hovedmenyen</span>{/if}
				{#if a.inPatientTabs}<span class="merke merke-info">Egen fane i journalen</span>{/if}
				{#if !a.requireConsent}<span class="merke merke-ok">Godkjent av virksomheten</span>{/if}
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
			{#if a.launchUrl}
				<form method="POST" action="?/samtykke" class="rad">
					<input type="hidden" name="clientId" value={a.clientId} />
					<input type="hidden" name="krevSamtykke" value={a.requireConsent ? 'nei' : 'ja'} />
					<button type="submit" class="liten">
						{a.requireConsent
							? 'Godkjenn på vegne av virksomheten'
							: 'Krev at hver bruker godkjenner'}
					</button>
				</form>
				<form method="POST" action="?/plassering" class="rad">
					<input type="hidden" name="clientId" value={a.clientId} />
					<select name="plassering" aria-label="Plassering i journalen">
						<option value="ingen" selected={a.placement === 'ingen'}>Startes ved behov</option>
						<option value="hoved" selected={a.placement === 'hoved'}>Stor flate i journalen</option>
						<option value="side" selected={a.placement === 'side'}>Sidepanel i journalen</option>
					</select>
					<button type="submit" class="liten">Lagre plassering</button>
				</form>
				<!-- An app used in most consultations gets a tab of its own beside
				     the record's tabs, instead of a place under the Apper dropdown. -->
				<form method="POST" action="?/pasientfane">
					<input type="hidden" name="clientId" value={a.clientId} />
					<input type="hidden" name="iPasientfaner" value={a.inPatientTabs ? 'nei' : 'ja'} />
					<button type="submit" class="liten">
						{a.inPatientTabs ? 'Flytt tilbake under «Apper»' : 'Vis som egen fane i journalen'}
					</button>
				</form>
				<!-- The main menu is for apps that work across patients and start
				     without one - a worklist, an inbox. An app for one patient is
				     reached from the record and does not belong here. -->
				<form method="POST" action="?/hovedmeny">
					<input type="hidden" name="clientId" value={a.clientId} />
					<input type="hidden" name="iHovedmeny" value={a.inMainMenu ? 'nei' : 'ja'} />
					<button type="submit" class="liten">
						{a.inMainMenu ? 'Ta ut av hovedmenyen' : 'Vis i hovedmenyen (uten pasient)'}
					</button>
				</form>
			{/if}
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
