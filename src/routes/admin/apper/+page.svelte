<script lang="ts">
	let { data, form } = $props();

	/**
	 * Where the app shows up, in one line.
	 *
	 * Four separate settings decide this - the placement, its own tab, the main
	 * menu, and whether it gets its own window - and reading four badges to work
	 * out where an app actually appears is the thing that made this page hard to
	 * scan. Said once, in words, it can be read at a glance.
	 */
	function visesHvor(a: {
		placement: string;
		inPatientTabs: boolean;
		inMainMenu: boolean;
		openInNewTab: boolean;
		launchUrl: string | null;
	}): string {
		if (!a.launchUrl) return 'Ingen launch-URL — kan ikke startes fra journalen';
		const steder: string[] = [];
		if (a.placement === 'hoved') steder.push('stor flate i journalen');
		else if (a.placement === 'side') steder.push('sidepanel i journalen');
		if (a.inPatientTabs) steder.push('egen fane i journalen');
		if (a.inMainMenu) steder.push('hovedmenyen');
		if (!steder.length) steder.push('under «Apper» i journalen');
		steder.push(a.openInNewTab ? 'åpnes i eget vindu' : 'åpnes i ramme');
		return steder.join(' · ');
	}
</script>

<div class="rad-mellom">
	<h2>SMART-apper og tjenester</h2>
	<a class="knapp" href="/admin/apper/galleri">Appgalleri</a>
</div>

<div class="varsel varsel-info">
	FHIR-endepunkt: <span class="mono">{data.fhirBaseUrl}</span><br />
	Appen må sende dette som <span class="mono">aud</span>, og får det samme som
	<span class="mono">iss</span> ved oppstart fra journalen. Adressen til nettstedet alene
	(<span class="mono">{data.issuerUrl}</span>) er utstederen, ikke FHIR-endepunktet.<br />
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
	<details class="nyapp">
		<summary><h3>Registrer app</h3></summary>
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
	</details>
</section>

<h3 class="listetittel">Registrerte apper ({data.apper.length})</h3>

{#each data.apper as a (a.clientId)}
	<article class="app" class:app-sperret={a.status !== 'aktiv'}>
		<details>
			<summary>
				<div class="app-hode">
					<div class="app-tittel">
						<span class="app-navn">{a.name}</span>
						<span class="merker">
							{#if a.status !== 'aktiv'}<span class="merke merke-fare">sperret</span>{/if}
							{#if !a.databehandleravtale}<span class="merke merke-advarsel">uten DBA</span>{/if}
							{#if !a.requireConsent}<span class="merke merke-ok">godkjent av virksomheten</span>{/if}
							<span class="merke">{a.category}</span>
						</span>
					</div>
					<p class="app-hvor">{visesHvor(a)}</p>
					<p class="app-id mono">{a.clientId}</p>
				</div>
			</summary>

			<div class="app-detalj">
				<dl class="fakta">
					<div><dt>Registrert</dt><dd>{a.created_at}</dd></div>
					<div><dt>Aktive tokens</dt><dd>{a.aktiveTokens}</dd></div>
					<div><dt>Klientautentisering</dt><dd>{a.hasKeys ? 'asymmetrisk' : a.type}</dd></div>
					<div><dt>Databehandleravtale</dt><dd>{a.databehandleravtale || '—'}</dd></div>
				</dl>

				{#if a.redirectUris.length}
					<dl class="fakta">
						<div class="bred">
							<dt>Redirect-URI-er</dt>
							<dd class="mono">{a.redirectUris.join(' ')}</dd>
						</div>
					</dl>
				{/if}

				<details class="underseksjon">
					<summary>Tillatte tilganger ({a.scopes.length})</summary>
					<ul class="scopeliste">
						{#each a.scopes as s (s.scope)}<li><span class="mono">{s.scope}</span> <span class="svak">{s.description}</span></li>{/each}
					</ul>
				</details>

				{#if a.launchUrl}
					<section class="gruppe">
						<h4>Hvor appen vises</h4>
						<p class="gruppe-hjelp">
							Uten noe valgt startes appen ved behov fra «Apper» i journalen.
						</p>
						<div class="knapperad">
							<form method="POST" action="?/plassering" class="rad">
								<input type="hidden" name="clientId" value={a.clientId} />
								<select name="plassering" aria-label="Plassering i journalen">
									<option value="ingen" selected={a.placement === 'ingen'}>Startes ved behov</option>
									<option value="hoved" selected={a.placement === 'hoved'}>Stor flate i journalen</option>
									<option value="side" selected={a.placement === 'side'}>Sidepanel i journalen</option>
								</select>
								<button type="submit" class="liten">Lagre</button>
							</form>
							<!-- An app used in most consultations gets a tab of its own beside
							     the record's tabs, instead of a place under the Apper dropdown. -->
							<form method="POST" action="?/pasientfane">
								<input type="hidden" name="clientId" value={a.clientId} />
								<input type="hidden" name="iPasientfaner" value={a.inPatientTabs ? 'nei' : 'ja'} />
								<button type="submit" class="liten" class:valgt={a.inPatientTabs}>
									{a.inPatientTabs ? '✓ Egen fane i journalen' : 'Egen fane i journalen'}
								</button>
							</form>
							<!-- The main menu is for apps that work across patients and start
							     without one - a worklist, an inbox. An app for one patient is
							     reached from the record and does not belong here. -->
							<form method="POST" action="?/hovedmeny">
								<input type="hidden" name="clientId" value={a.clientId} />
								<input type="hidden" name="iHovedmeny" value={a.inMainMenu ? 'nei' : 'ja'} />
								<button type="submit" class="liten" class:valgt={a.inMainMenu}>
									{a.inMainMenu ? '✓ I hovedmenyen' : 'I hovedmenyen (uten pasient)'}
								</button>
							</form>
							<!-- A framed app is a third-party context, so the browser withholds
							     the cookies it needs. Apps that carry a session through the
							     handshake have to be their own top-level document. -->
							<form method="POST" action="?/ownWindow">
								<input type="hidden" name="clientId" value={a.clientId} />
								<input type="hidden" name="iEgetVindu" value={a.openInNewTab ? 'nei' : 'ja'} />
								<button type="submit" class="liten" class:valgt={a.openInNewTab}>
									{a.openInNewTab ? '✓ Eget vindu' : 'Eget vindu'}
								</button>
							</form>
						</div>
					</section>

					<section class="gruppe">
						<h4>Samtykke</h4>
						<p class="gruppe-hjelp">
							{a.requireConsent
								? 'Hver bruker må godkjenne appen første gang de starter den.'
								: 'Virksomheten har godkjent appen på alles vegne. Ingen blir spurt.'}
						</p>
						<div class="knapperad">
							<form method="POST" action="?/samtykke">
								<input type="hidden" name="clientId" value={a.clientId} />
								<input type="hidden" name="krevSamtykke" value={a.requireConsent ? 'nei' : 'ja'} />
								<button type="submit" class="liten">
									{a.requireConsent ? 'Godkjenn på vegne av virksomheten' : 'Krev at hver bruker godkjenner'}
								</button>
							</form>
						</div>
					</section>
				{/if}

				<details class="underseksjon">
					<summary>Rediger appen</summary>
					<!-- Everything but the client id and the client type. A wider scope
					     list withdraws the users' remembered consents; they are asked again. -->
					<form method="POST" action="?/oppdater" class="redigerskjema">
						<input type="hidden" name="clientId" value={a.clientId} />
						<div class="feltrad">
							<div style="flex:1 1 14rem">
								<label for="navn-{a.clientId}">Navn</label>
								<input id="navn-{a.clientId}" name="navn" value={a.name} required />
							</div>
							<div style="flex:1 1 12rem">
								<label for="dba-{a.clientId}">Databehandleravtale</label>
								<input id="dba-{a.clientId}" name="databehandleravtale" value={a.databehandleravtale ?? ''} />
							</div>
						</div>
						{#if a.category !== 'backend'}
							<div class="felt">
								<label for="redirect-{a.clientId}">Redirect-URI-er</label>
								<textarea id="redirect-{a.clientId}" name="redirectUris" style="min-height:4rem">{a.redirectUris.join('\n')}</textarea>
								<small>
									Én per linje. Sammenliknes eksakt, så <span class="mono">/callback</span> og
									<span class="mono">/callback/</span> er to ulike adresser.
								</small>
							</div>
						{/if}
						<div class="felt">
							<label for="scopes-{a.clientId}">Tillatte scope</label>
							<textarea id="scopes-{a.clientId}" name="scopes" style="min-height:4rem">{a.scopes.map((s) => s.scope).join(' ')}</textarea>
							<small>Utvides listen, må hver bruker godkjenne appen på nytt.</small>
						</div>
						<div class="feltrad">
							<div style="flex:1 1 18rem">
								<label for="launch-{a.clientId}">Launch-URL (EHR launch)</label>
								<input id="launch-{a.clientId}" name="launchUrl" value={a.launchUrl ?? ''} />
							</div>
							<div style="flex:1 1 16rem">
								<label for="jwksuri-{a.clientId}">jwks_uri</label>
								<input id="jwksuri-{a.clientId}" name="jwksUri" value={a.jwksUri} />
							</div>
						</div>
						<div class="feltrad">
							<div style="flex:1 1 18rem">
								<label for="logo-{a.clientId}">Logo-URL</label>
								<input id="logo-{a.clientId}" name="logoUrl" value={a.logoUrl} />
							</div>
						</div>
						<div class="felt">
							<label for="jwks-{a.clientId}">JWKS (JSON)</label>
							<textarea id="jwks-{a.clientId}" name="jwks">{a.jwks}</textarea>
						</div>
						<button type="submit" class="primar liten">Lagre endringer</button>
					</form>
				</details>

				<div class="bunnrad">
					{#if a.category !== 'backend'}
						<form method="POST" action="?/testlaunch" class="rad">
							<input type="hidden" name="clientId" value={a.clientId} />
							<input name="patientId" placeholder="Pasient-id" style="width:9rem" />
							<button type="submit" class="liten">Lag launch-kontekst</button>
						</form>
					{/if}
					<form method="POST" action="?/status">
						<input type="hidden" name="clientId" value={a.clientId} />
						<input type="hidden" name="status" value={a.status === 'aktiv' ? 'sperret' : 'aktiv'} />
						<button type="submit" class="liten" class:fare={a.status === 'aktiv'}>
							{a.status === 'aktiv' ? 'Sperr appen og trekk tilbake tokens' : 'Aktiver appen'}
						</button>
					</form>
				</div>
			</div>
		</details>
	</article>
{/each}

<style>
	.listetittel {
		margin: 1.75rem 0 0.6rem;
		font-size: 1rem;
	}

	/* Registration is an occasional act; the list is what the page is for. */
	.nyapp > summary {
		cursor: pointer;
		list-style: none;
	}

	.nyapp > summary::-webkit-details-marker { display: none; }

	.nyapp > summary h3 {
		display: inline;
		font-size: 1rem;
	}

	.nyapp > summary::before {
		content: '+ ';
		color: var(--primar);
		font-weight: 600;
	}

	.nyapp[open] > summary::before { content: '− '; }

	/* One app is one row until you ask for more. Ten apps used to be ten screens. */
	.app {
		background: var(--flate);
		border: 1px solid var(--kant);
		border-radius: var(--radius);
		margin-bottom: 0.5rem;
	}

	.app-sperret { background: var(--flate-2); }

	.app > details > summary {
		cursor: pointer;
		padding: 0.7rem 0.9rem;
		list-style: none;
		display: block;
	}

	.app > details > summary::-webkit-details-marker { display: none; }

	.app > details > summary:hover { background: var(--primar-svak); }

	.app > details > summary:focus-visible {
		outline: 2px solid var(--primar);
		outline-offset: -2px;
	}

	.app-hode {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) minmax(10rem, 1.2fr) auto;
		gap: 0.3rem 1rem;
		align-items: baseline;
	}

	.app-tittel {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: baseline;
	}

	.app-navn { font-weight: 600; }

	.merker { display: flex; flex-wrap: wrap; gap: 0.25rem; }

	.app-hvor, .app-id {
		margin: 0;
		font-size: 0.82rem;
		color: var(--tekst-svak);
	}

	.app-id { text-align: right; }

	.app-detalj {
		border-top: 1px solid var(--kant);
		padding: 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* Facts read as a table, not as a run of grey sentences. */
	.fakta {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.6rem 1.25rem;
		margin: 0;
	}

	.fakta .bred { grid-column: 1 / -1; }

	.fakta dt {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--tekst-svak);
	}

	.fakta dd {
		margin: 0.1rem 0 0;
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}

	.gruppe {
		border: 1px solid var(--kant);
		border-radius: var(--radius);
		padding: 0.7rem 0.8rem;
	}

	.gruppe h4 {
		margin: 0 0 0.15rem;
		font-size: 0.85rem;
	}

	.gruppe-hjelp {
		margin: 0 0 0.6rem;
		font-size: 0.82rem;
		color: var(--tekst-svak);
	}

	.knapperad {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}

	/* A setting that is on says so, instead of only offering to turn it off. */
	.knapperad :global(button.valgt) {
		background: var(--primar-svak);
		border-color: var(--primar);
		color: var(--primar-mork);
	}

	.underseksjon > summary {
		cursor: pointer;
		font-size: 0.88rem;
		padding: 0.2rem 0;
	}

	.scopeliste {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.86rem;
	}

	.scopeliste li { margin-bottom: 0.15rem; }

	.redigerskjema { margin-top: 0.6rem; }

	/* Testing and blocking are not settings, so they sit below the rule. */
	.bunnrad {
		border-top: 1px solid var(--kant);
		padding-top: 0.8rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: space-between;
		align-items: center;
	}

	@media (max-width: 46rem) {
		.app-hode { grid-template-columns: 1fr; }
		.app-id { text-align: left; }
	}
</style>
