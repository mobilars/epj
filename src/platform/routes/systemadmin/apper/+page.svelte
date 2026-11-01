<script lang="ts">
	import AppForm from '$lib/components/AppForm.svelte';
	let { data, form } = $props();

	const CLIENT_TYPE: Record<string, string> = {
		public: 'Ingen hemmelighet, bare PKCE',
		secret: 'Klienthemmelighet',
		keys: 'Offentlige nøkler (private_key_jwt)'
	};
</script>

<div class="rad-mellom">
	<h2>Apper</h2>
	<a href="/systemadmin">← Alle virksomheter</a>
</div>

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}

{#snippet detaljer(app: (typeof data.waiting)[number])}
	<p class="svak">
		{app.developerName || app.developer}
		{#if app.organisation}· {app.organisation}{/if}
		· <span class="mono">{app.developer}</span>
	</p>
	{#if app.summary}<p>{app.summary}</p>{/if}
	{#if app.description}<p class="svak">{app.description}</p>{/if}
	<table>
		<tbody>
			<tr><th>Klient-id</th><td class="mono">{app.clientId}</td></tr>
			<tr><th>Launch</th><td class="mono">{app.launchUrl}</td></tr>
			<tr><th>Redirect</th><td class="mono">{app.redirectUris.join(' ')}</td></tr>
			<tr><th>Plassering</th><td>{app.placement}</td></tr>
			<tr><th>Klientautentisering</th><td>{CLIENT_TYPE[app.clientType] ?? app.clientType}</td></tr>
			<tr><th>Kontakt</th><td>{app.contactEmail || '—'}</td></tr>
			<tr><th>Personvern</th><td>{app.privacyUrl || '—'}</td></tr>
			<tr><th>Databehandleravtale</th><td>{app.databehandleravtale || '—'}</td></tr>
		</tbody>
	</table>
	<h4>Ber om {app.scopes.length} tilganger</h4>
	<ul>
		{#each app.scopes as s (s.scope)}
			<li><span class="mono">{s.scope}</span> — {s.description}</li>
		{/each}
	</ul>
{/snippet}

{#if form?.secret}
	<div class="varsel varsel-ok" role="status">
		Klienthemmelighet for <strong>{form.secretFor}</strong>: <strong class="mono">{form.secret}</strong><br />
		Den vises bare nå. Ta vare på den før du går videre.
	</div>
{/if}

<section class="kort">
	<h3>Plattformapper ({data.platform.length})</h3>
	<p class="svak">
		Plattformens egne apper. Virksomheter installerer dem fra appgalleriet, og de regnes som godkjent.
		Endringer her gjelder med en gang i alle virksomheter som har appen.
	</p>
	{#each data.platform as app (app.id)}
		<details>
			<summary>
				{app.name}
				{#if app.status !== 'godkjent'}<span class="merke merke-fare">Trukket tilbake</span>{/if}
				<span class="svak liten">· installert hos {app.installs} {app.installs === 1 ? 'virksomhet' : 'virksomheter'}</span>
			</summary>
			<p class="liten">Klient-id: <span class="mono">{app.clientId}</span></p>
			<form method="POST" action="?/plattformapp">
				<input type="hidden" name="id" value={app.id} />
				<AppForm {app} idPrefix={app.id} showReplacesTab />
				<button type="submit" class="primar liten">Lagre</button>
			</form>
			<form method="POST" action="?/vurder" style="margin-top: 1rem">
				<input type="hidden" name="id" value={app.id} />
				{#if app.status === 'godkjent'}
					<div class="felt">
						<label for="trekk-p-{app.id}">Begrunnelse for å trekke tilbake</label>
						<textarea id="trekk-p-{app.id}" name="begrunnelse" rows="2"></textarea>
					</div>
					<button type="submit" name="utfall" value="avvist" class="liten fare">Trekk tilbake</button>
				{:else}
					<button type="submit" name="utfall" value="godkjent" class="liten">Gjør tilgjengelig igjen</button>
				{/if}
			</form>
			<form
				method="POST"
				action="?/slettPlattformapp"
				style="margin-top: 0.5rem"
				onsubmit={(event) => {
					if (!confirm(`Slette ${app.name}? Den fjernes fra ${app.installs} virksomheter med en gang. Dette kan ikke angres.`)) event.preventDefault();
				}}
			>
				<input type="hidden" name="id" value={app.id} />
				<button type="submit" class="liten fare">Slett appen</button>
			</form>
		</details>
	{:else}
		<p class="svak">Ingen plattformapper ennå.</p>
	{/each}
	<details>
		<summary>Legg til plattformapp</summary>
		<form method="POST" action="?/plattformapp">
			<AppForm idPrefix="ny-plattformapp" showReplacesTab />
			<button type="submit" class="primar liten">Legg til</button>
		</form>
	</details>
</section>

<section class="kort">
	<h3>Venter på vurdering ({data.waiting.length})</h3>
	{#each data.waiting as app (app.id)}
		<div class="kort">
			<h3>{app.name}</h3>
			{@render detaljer(app)}
			<form method="POST" action="?/vurder">
				<input type="hidden" name="id" value={app.id} />
				<div class="felt">
					<label for="begrunnelse-{app.id}">Begrunnelse</label>
					<textarea id="begrunnelse-{app.id}" name="begrunnelse" rows="2"
						placeholder="Ved avslag: hva må rettes?"></textarea>
				</div>
				<div class="rad">
					<button type="submit" name="utfall" value="godkjent" class="primar liten">Godkjenn</button>
					<button type="submit" name="utfall" value="avvist" class="liten fare">Avvis</button>
				</div>
			</form>
		</div>
	{:else}
		<p class="svak">Ingenting venter.</p>
	{/each}
</section>

<section class="kort">
	<h3>Godkjent ({data.approved.length})</h3>
	{#each data.approved as app (app.id)}
		<details>
			<summary>
				{app.name} — {app.developer}
				<span class="svak liten">· installert hos {app.installs} {app.installs === 1 ? 'virksomhet' : 'virksomheter'}</span>
			</summary>
			{@render detaljer(app)}
			<form method="POST" action="?/vurder">
				<input type="hidden" name="id" value={app.id} />
				<div class="felt">
					<label for="trekk-{app.id}">Begrunnelse for å trekke tilbake</label>
					<textarea id="trekk-{app.id}" name="begrunnelse" rows="2"></textarea>
				</div>
				<p class="svak liten">
					Å trekke tilbake sperrer appen hos alle {app.installs}
					{app.installs === 1 ? 'virksomheten' : 'virksomhetene'} som har installert den, med
					øyeblikkelig virkning. Begrunnelsen vises til utvikleren og til virksomhetene.
				</p>
				<button type="submit" name="utfall" value="avvist" class="liten fare">Trekk tilbake</button>
			</form>
		</details>
	{:else}
		<p class="svak">Ingen godkjente apper.</p>
	{/each}
</section>

<section class="kort">
	<h3>Utviklere ({data.developers.length})</h3>
	<div class="tabell-omslag">
		<table>
			<thead><tr><th>E-post</th><th>Navn</th><th>Virksomhet</th><th>Sist innlogget</th></tr></thead>
			<tbody>
				{#each data.developers as d (d.email)}
					<tr>
						<td class="mono">{d.email}</td>
						<td>{d.name}</td>
						<td>{d.organisation}</td>
						<td class="svak">{d.lastLogin ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>
