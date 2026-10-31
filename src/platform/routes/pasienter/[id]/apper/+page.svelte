<script lang="ts">
	import { page } from '$app/state';
	import { NOT_APPROVED } from '$lib/external-app';
	let { data, form } = $props();
	const unapproved = (clientId: string) =>
		page.data.apps?.find((app: { clientId: string }) => app.clientId === clientId)?.approved === false;
</script>

<h2>Apper</h2>
<p class="svak">
	Appene under er godkjent av virksomheten. Når du starter en app, får den
	tilgang til denne pasienten - aldri mer enn din egen rolle tillater, og alle
	oppslag appen gjør blir loggført på deg.
</p>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.ok}
	<div class="varsel varsel-ok" role="status">
		<strong>{form.appName}</strong> er klar til å åpnes.<br />
		<a href={form.url} rel="noopener noreferrer" target="_blank">Åpne appen</a><br />
		<span class="svak mono">launch: {form.launchId}</span>
	</div>
{/if}

{#if data.apper.length === 0}
	<p class="svak">Ingen apper er registrert for oppstart fra journalen.</p>
{:else}
	{#each data.apper as a (a.clientId)}
		<article class="kort">
			<div class="rad-mellom">
				<h3>{a.name}</h3>
				<form method="POST" action="?/start">
					<input type="hidden" name="clientId" value={a.clientId} />
					<button type="submit" class="primar">Start app</button>
				</form>
			</div>
			{#if unapproved(a.clientId)}<p><span class="merke merke-advarsel">⚠ {NOT_APPROVED}</span></p>{/if}
			<p class="mono svak" data-testid="client-id">{a.clientId}</p>
			{#if !a.databehandleravtale}
				<div class="varsel varsel-advarsel">Ingen databehandleravtale registrert for denne appen.</div>
			{/if}
			<ul class="svak">{#each a.scopes as s}<li>{s}</li>{/each}</ul>
		</article>
	{/each}
{/if}
