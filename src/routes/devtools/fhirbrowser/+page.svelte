<script lang="ts">
	let { data } = $props();
</script>

<h1>FHIR-utforsker</h1>
<p class="svak">
	Leser ressursene gjennom den samme vokteren som API-et. Du ser bare det rollen din har tilgang
	til, og hvert oppslag loggføres. Endepunktet er <span class="mono">{data.fhirBase}</span>.
</p>

<form method="GET" class="kort">
	<div class="rad">
		<div style="flex:0 1 16rem">
			<label for="type">Ressurstype</label>
			<select id="type" name="type">
				{#each data.types as t (t)}
					<option value={t} selected={t === data.type}>{t}</option>
				{/each}
			</select>
		</div>
		<div style="flex:0 1 14rem">
			<label for="pasient">Pasient-id</label>
			<input id="pasient" name="pasient" value={data.patient} placeholder="valgfritt" />
		</div>
		<div style="flex:0 1 14rem">
			<label for="id">Ressurs-id</label>
			<input id="id" name="id" value={data.id} placeholder="åpner én ressurs" />
		</div>
		<button type="submit" class="primar" style="align-self:flex-end">Hent</button>
	</div>
</form>

{#if data.single}
	<div class="kort">
		<h2>{data.type}/{data.id}</h2>
		<pre class="fhir-json">{data.single}</pre>
	</div>
{:else}
	<div class="kort">
		<h2>{data.type} ({data.list.length})</h2>
		{#if data.list.length === 0}
			<p class="svak">Ingen treff. Husk at du bare ser pasienter du har behandlingsrelasjon til.</p>
		{:else}
			<div class="tabell-omslag">
				<table>
					<thead><tr><th>Id</th><th>Versjon</th><th>Sist endret</th><th>Innhold</th></tr></thead>
					<tbody>
						{#each data.list as r (r.id)}
							<tr>
								<td><a href="?type={data.type}&id={r.id}" class="mono">{r.id}</a></td>
								<td class="tall">{r.version}</td>
								<td>{r.lastUpdated}</td>
								<td class="mono svak">{r.summary}…</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{/if}

<style>
	.fhir-json {
		background: var(--flate-2);
		border: 1px solid var(--kant);
		border-radius: 6px;
		padding: 0.75rem;
		overflow-x: auto;
		font-size: 0.85rem;
		line-height: 1.45;
	}
</style>
