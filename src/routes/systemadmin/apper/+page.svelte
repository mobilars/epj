<script lang="ts">
	let { data, form } = $props();
</script>

<div class="rad-mellom">
	<h2>Apper til vurdering</h2>
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
			<tr><th>Launch</th><td class="mono">{app.launchUrl}</td></tr>
			<tr><th>Redirect</th><td class="mono">{app.redirectUris.join(' ')}</td></tr>
			<tr><th>Plassering</th><td>{app.placement}</td></tr>
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

<section class="kort">
	<h3>Venter ({data.waiting.length})</h3>
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
			<summary>{app.name} — {app.developer}</summary>
			{@render detaljer(app)}
			<form method="POST" action="?/vurder">
				<input type="hidden" name="id" value={app.id} />
				<div class="felt">
					<label for="trekk-{app.id}">Begrunnelse for å trekke tilbake</label>
					<textarea id="trekk-{app.id}" name="begrunnelse" rows="2"></textarea>
				</div>
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
