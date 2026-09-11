<script lang="ts">
	let { data, form } = $props();
</script>

<div class="rad-mellom">
	<h1>Appgalleri</h1>
	<a href="/admin/apper">← Registrerte apper</a>
</div>

<p class="svak">
	Apper som er godkjent av plattformen. Installerer du en, får virksomheten sin egen klient med
	egen klient-id – appen deler ingenting med andre virksomheter som bruker den.
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
	</div>
{/if}

{#each data.apps as app (app.id)}
	<section class="kort">
		<div class="rad-mellom">
			<h2>{app.name}</h2>
			{#if app.withdrawn}<span class="merke merke-fare">Trukket tilbake</span>
			{:else if app.installed}<span class="merke merke-ok">Installert</span>{/if}
		</div>
		{#if app.withdrawn}
			<div class="varsel varsel-feil" role="alert">
				Plattformen har trukket tilbake godkjenningen av denne appen. Den er sperret i
				virksomheten og kan ikke lenger startes eller hente data.
				{#if app.reviewNote}<br /><strong>Begrunnelse:</strong> {app.reviewNote}{/if}
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
			<button type="submit" class={app.installed ? 'liten' : 'primar liten'}>
				{app.installed ? 'Fjern fra virksomheten' : 'Installer'}
			</button>
		</form>
	</section>
{:else}
	<p class="svak">Ingen godkjente apper i galleriet ennå.</p>
{/each}
