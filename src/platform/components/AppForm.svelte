<script lang="ts">
	/** Describing an app, the same way for a developer and for the platform. Read by `readAppForm`. */
	interface AppValues {
		name: string;
		placement: string;
		summary: string;
		description: string;
		launchUrl: string;
		redirectUris: string[];
		scopeText: string;
		contactEmail: string;
		privacyUrl: string;
		databehandleravtale: string;
		clientType: string;
		jwksUri: string;
		jwksText: string;
		replacesTab?: string;
	}

	let {
		app,
		idPrefix,
		showReplacesTab = false
	}: { app?: AppValues; idPrefix: string; showReplacesTab?: boolean } = $props();

	// svelte-ignore state_referenced_locally
	let clientType = $state(app?.clientType ?? 'public');
</script>

<div class="feltrad">
	<div style="flex:1 1 14rem">
		<label for="{idPrefix}-navn">Navn</label>
		<input id="{idPrefix}-navn" name="navn" required value={app?.name ?? ''} />
	</div>
	<div style="flex:0 1 12rem">
		<label for="{idPrefix}-plassering">Plassering</label>
		<select id="{idPrefix}-plassering" name="plassering">
			<option value="ingen" selected={!app || app.placement === 'ingen'}>Startes ved behov</option>
			<option value="hoved" selected={app?.placement === 'hoved'}>Stor flate</option>
			<option value="side" selected={app?.placement === 'side'}>Sidepanel</option>
		</select>
	</div>
	{#if showReplacesTab}
		<div style="flex:0 1 12rem">
			<label for="{idPrefix}-fane">Overtar fanen</label>
			<select id="{idPrefix}-fane" name="erstatterFane">
				<option value="" selected={!app?.replacesTab}>Ingen</option>
				<option value="notater" selected={app?.replacesTab === 'notater'}>Journalnotater</option>
				<option value="legemidler" selected={app?.replacesTab === 'legemidler'}>Legemidler</option>
				<option value="meldinger" selected={app?.replacesTab === 'meldinger'}>Meldinger</option>
				<option value="oppgjor" selected={app?.replacesTab === 'oppgjor'}>Oppgjør</option>
			</select>
			<small class="svak">Gjelder for virksomheter som installerer appen fra nå av.</small>
		</div>
	{/if}
</div>
<div class="felt">
	<label for="{idPrefix}-kort">Kort beskrivelse</label>
	<input id="{idPrefix}-kort" name="kortbeskrivelse" value={app?.summary ?? ''} placeholder="Én setning om hva appen gjør" />
</div>
<div class="felt">
	<label for="{idPrefix}-beskrivelse">Beskrivelse</label>
	<textarea id="{idPrefix}-beskrivelse" name="beskrivelse" rows="3">{app?.description ?? ''}</textarea>
</div>
<div class="felt">
	<label for="{idPrefix}-launch">Launch-URL</label>
	<input id="{idPrefix}-launch" name="launchUrl" required value={app?.launchUrl ?? ''} placeholder="https://app.example/launch?client_id={'{client_id}'}" />
	<small class="svak">Skriv <span class="mono">{'{client_id}'}</span> der klient-id-en skal settes inn.</small>
</div>
<div class="felt">
	<label for="{idPrefix}-redirect">Redirect-URI-er</label>
	<textarea id="{idPrefix}-redirect" name="redirectUris" rows="2" placeholder="https://app.example/callback">{app?.redirectUris.join('\n') ?? ''}</textarea>
	<small class="svak">Én per linje. Sammenliknes eksakt.</small>
</div>
<div class="felt">
	<label for="{idPrefix}-scopes">Scopes</label>
	<textarea id="{idPrefix}-scopes" name="scopes" rows="2" placeholder="openid fhirUser launch patient/Patient.rs">{app?.scopeText ?? ''}</textarea>
	<small class="svak">Be om det minste appen trenger. Alt her blir vurdert.</small>
</div>
<div class="felt">
	<label for="{idPrefix}-klienttype">Klientautentisering</label>
	<select id="{idPrefix}-klienttype" name="klienttype" bind:value={clientType}>
		<option value="public">Ingen hemmelighet, bare PKCE (app i nettleseren)</option>
		<option value="secret">Klienthemmelighet (app med egen tjener)</option>
		<option value="keys">Offentlige nøkler, private_key_jwt (app med egen tjener)</option>
	</select>
	{#if clientType === 'secret'}
		<small class="svak">
			Hemmeligheten lages når du lagrer, og vises bare én gang. Hemmeligheten og klient-id-en er de
			samme i alle virksomheter.
		</small>
	{/if}
</div>
{#if clientType === 'keys'}
	<div class="felt">
		<label for="{idPrefix}-jwksuri">jwks_uri</label>
		<input id="{idPrefix}-jwksuri" name="jwksUri" value={app?.jwksUri ?? ''} placeholder="https://app.example/jwks.json" />
	</div>
	<div class="felt">
		<label for="{idPrefix}-jwks">JWKS (JSON)</label>
		<textarea id="{idPrefix}-jwks" name="jwks" rows="3" placeholder={'{"keys":[...]}'}>{app?.jwksText ?? ''}</textarea>
		<small class="svak">Enten jwks_uri eller JWKS. Bare den offentlige delen av nøkkelen.</small>
	</div>
{/if}
<div class="feltrad">
	<div style="flex:1 1 12rem">
		<label for="{idPrefix}-kontakt">Kontakt-e-post</label>
		<input id="{idPrefix}-kontakt" name="kontaktEpost" value={app?.contactEmail ?? ''} />
	</div>
	<div style="flex:1 1 12rem">
		<label for="{idPrefix}-personvern">Personvernerklæring</label>
		<input id="{idPrefix}-personvern" name="personvernUrl" value={app?.privacyUrl ?? ''} />
	</div>
</div>
<div class="felt">
	<label for="{idPrefix}-dba">Databehandleravtale</label>
	<input id="{idPrefix}-dba" name="databehandleravtale" value={app?.databehandleravtale ?? ''} />
	<small class="svak">Referanse til avtalen, om det finnes en.</small>
</div>
