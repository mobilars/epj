<script lang="ts">
	import AppForm from '$lib/components/AppForm.svelte';
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

{#if form?.secret}
	<div class="varsel varsel-ok" role="status">
		Klienthemmelighet for <strong>{form.secretFor}</strong>: <strong class="mono">{form.secret}</strong><br />
		Den vises bare nå. Ta vare på den før du går videre.
	</div>
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
		<p class="liten">
			Klient-id: <strong class="mono" data-testid="app-client-id">{app.clientId}</strong><br />
			<span class="svak">Den samme i alle virksomheter som installerer appen.</span>
		</p>

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
				<AppForm {app} idPrefix={app.id} />
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

		{#if app.clientType === 'secret' && app.hasSecret}
			<form method="POST" action="?/nyHemmelighet">
				<input type="hidden" name="id" value={app.id} />
				<input type="hidden" name="navn" value={app.name} />
				<button type="submit" class="liten">Lag ny klienthemmelighet</button>
				<small class="svak">Den gamle slutter å virke med en gang, også hos virksomheter som har appen.</small>
			</form>
		{/if}

		{#if app.canSubmit}
			<form method="POST" action="?/send">
				<input type="hidden" name="id" value={app.id} />
				<button type="submit" class="primar liten">Send til vurdering</button>
			</form>
		{/if}

		<form
			method="POST"
			action="?/slett"
			onsubmit={(event) => {
				const where = app.installs ? ` Den fjernes også fra ${app.installs} ${app.installs === 1 ? 'virksomhet' : 'virksomheter'} og slutter å virke der med en gang.` : '';
				if (!confirm(`Slette ${app.name}?${where} Dette kan ikke angres.`)) event.preventDefault();
			}}
		>
			<input type="hidden" name="id" value={app.id} />
			<button type="submit" class="liten fare">Slett appen</button>
			{#if app.installs}
				<small class="svak">Installert hos {app.installs} {app.installs === 1 ? 'virksomhet' : 'virksomheter'}.</small>
			{/if}
		</form>
	</section>
{:else}
	<p class="svak">Du har ingen apper ennå.</p>
{/each}

<section class="kort">
	<h2>Ny app</h2>
	<form method="POST" action="?/nyApp">
		<AppForm idPrefix="ny" />
		<button type="submit" class="primar">Opprett</button>
	</form>
</section>
