<script lang="ts">
	import { NOT_APPROVED } from '$lib/external-app';
	let { data, form } = $props();
</script>

<div class="rad-mellom">
	<h1>Appgalleri</h1>
	<a href="/admin/apper">← Registrerte apper</a>
</div>

<p class="svak">
	Apper registrert i utviklerportalen. Installerer du en, får virksomheten sin egen klient med
	egen klient-id – appen deler ingenting med andre virksomheter som bruker den. Apper plattformeier
	ikke har godkjent ennå, er tydelig merket.
</p>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}
{#if form?.ok}
	<div class="varsel varsel-ok" role="status">
		<strong>{form.name}</strong> er installert som <span class="mono">{form.clientId}</span>.
		{#if form.secret}
			Klienthemmelighet: <span class="mono">{form.secret}</span> — vises bare nå.
		{/if}
		Hver bruker blir spurt om samtykke til appen er godkjent på vegne av virksomheten under
		<a href="/admin/apper">Registrerte apper</a>.
		{#if form.unapproved}<br /><strong>⚠ Appen er ikke godkjent av plattformeier.</strong> Brukerne ser en
			advarsel når de åpner den, og hver av dem må godkjenne den selv.{/if}
	</div>
{/if}

{#each data.apps as app (app.id)}
	<section class="kort">
		<div class="rad-mellom">
			<h2>{app.name}</h2>
			<span class="merker">
				{#if app.withdrawn}<span class="merke merke-fare">Trukket tilbake</span>
				{:else if app.installed}<span class="merke merke-ok">Installert</span>{/if}
				{#if app.unapproved}<span class="merke merke-advarsel">⚠ {NOT_APPROVED}</span>{/if}
				{#if app.changePending}<span class="merke">Endring venter på godkjenning</span>{/if}
			</span>
		</div>
		{#if app.withdrawn}
			<div class="varsel varsel-feil" role="alert">
				Plattformen har trukket tilbake godkjenningen av denne appen. Den er sperret i
				virksomheten og kan ikke lenger startes eller hente data.
				{#if app.reviewNote}<br /><strong>Begrunnelse:</strong> {app.reviewNote}{/if}
			</div>
		{/if}
		{#if app.unapproved}
			<div class="varsel varsel-advarsel">
				<strong>⚠ Plattformeier har ikke vurdert denne appen.</strong> Ingen har kontrollert at beskrivelsen
				stemmer, eller at appen bare ber om det den trenger. Bruker dere den, er det virksomhetens eget
				ansvar. Brukerne ser en advarsel, og hver av dem må godkjenne appen selv.
			</div>
		{/if}
		{#if app.changePending}
			<div class="varsel varsel-info">
				Utvikleren har sendt inn en endring. Virksomheten bruker den godkjente versjonen til plattformeier
				har godkjent endringen, og da oppdateres appen av seg selv. Teksten under viser den nye versjonen.
			</div>
		{/if}
		{#if app.summary}<p>{app.summary}</p>{/if}
		{#if app.description}<p class="svak">{app.description}</p>{/if}

		<details>
			<summary>Ber om {app.scopes.length} tilganger</summary>
			<ul>
				{#each app.scopes as s (s.scope)}
					<li><span class="mono">{s.scope}</span> — {s.description}</li>
				{/each}
			</ul>
		</details>

		<p class="svak liten">
			{#if app.databehandleravtale}Databehandleravtale: {app.databehandleravtale}{:else}
				<strong>Ingen databehandleravtale er oppgitt.</strong> Vurder om appen skal behandle
				helseopplysninger uten en.
			{/if}
			{#if app.privacyUrl}· <a href={app.privacyUrl} rel="noopener">Personvernerklæring</a>{/if}
			{#if app.contactEmail}· {app.contactEmail}{/if}
		</p>

		<form method="POST" action={app.installed ? '?/avinstaller' : '?/installer'}>
			<input type="hidden" name="id" value={app.id} />
			{#if app.unapproved && !app.installed}
				<label class="avkryssing">
					<input type="checkbox" name="bekreftet" value="ja" required />
					Jeg forstår at plattformeier ikke har godkjent {app.name}, og vil installere den likevel
				</label>
			{/if}
			<button type="submit" class={app.installed || app.unapproved ? 'liten' : 'primar liten'}>
				{app.installed ? 'Fjern fra virksomheten' : app.unapproved ? 'Installer uten godkjenning' : 'Installer'}
			</button>
		</form>
	</section>
{:else}
	<p class="svak">Ingen apper i galleriet ennå.</p>
{/each}
