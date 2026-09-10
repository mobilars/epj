<script lang="ts">
	let { data } = $props();
	const outcomeText: Record<string, string> = { '0': 'OK', '4': 'Avvist', '8': 'Feil', '12': 'Alvorlig feil' };
</script>

<h2>Sikkerhetslogg</h2>

{#if data.chain.valid}
	<div class="varsel varsel-ok">Hash-kjeden er ubrutt ({data.chain.checked} innslag kontrollert).</div>
{:else}
	<div class="varsel varsel-feil" role="alert">
		Brudd i hash-kjeden fra og med innslag {data.chain.firstBrudd?.seq}. Loggen kan ha blitt endret.
	</div>
{/if}

<form method="GET" class="kort">
	<div class="rad">
		<div style="flex:1 1 14rem"><label for="patientId">Pasient-id</label><input id="patientId" name="patientId" value={data.filter.patientId} /></div>
		<div style="flex:1 1 14rem"><label for="userId">Bruker-id</label><input id="userId" name="userId" value={data.filter.userId} /></div>
		<div style="flex:0 0 12rem">
			<label for="type">Hendelsestype</label>
			<select id="type" name="type">
				<option value="">Alle</option>
				{#each ['rest', 'login', 'emergency-override', 'integrasjon', 'oppgjor', 'admin', 'security-alert'] as t}
					<option value={t} selected={data.filter.type === t}>{t}</option>
				{/each}
			</select>
		</div>
		<label style="flex:0 0 auto; align-self:flex-end; font-weight:400">
			<input type="checkbox" name="nodrett" value="1" checked={data.filter.onlyEmergencyAccess} style="width:auto" /> Bare nødrett
		</label>
		<button type="submit" class="primar" style="align-self:flex-end">Filtrer</button>
	</div>
</form>

<div class="kort tabell-omslag">
	<table>
		<thead>
			<tr><th>#</th><th>Tidspunkt</th><th>Hvem</th><th>Hendelse</th><th>Pasient</th><th>Ressurs</th><th>Formål</th><th>Utfall</th></tr>
		</thead>
		<tbody>
			{#each data.rows as r (r.seq)}
				<tr>
					<td class="mono svak">{r.seq}</td>
					<td class="svak">{r.timestamp}</td>
					<td>{r.hvem}<br /><span class="svak">{r.role}{#if r.app} · {r.app}{/if}</span></td>
					<td>{r.type}<br /><span class="svak">{r.subtype}</span></td>
					<td>{#if r.patient}<a href="/pasienter/{r.patient}/logg">{r.patient.slice(0, 8)}…</a>{/if}</td>
					<td class="mono svak">{r.resource}</td>
					<td>{#if r.formal === 'ETREAT'}<span class="merke merke-fare">Nødrett</span>{:else}{r.formal}{/if}</td>
					<td><span class="merke" class:merke-ok={r.outcome === '0'} class:merke-advarsel={r.outcome === '4'} class:merke-fare={r.outcome === '8'}>{outcomeText[r.outcome] ?? r.outcome}</span></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="rad">
	{#if data.page > 0}<a class="knapp liten" href="?side={data.page - 1}">Forrige</a>{/if}
	<span class="svak">{data.page * 100 + 1}–{data.page * 100 + data.rows.length} av {data.total}</span>
	{#if (data.page + 1) * 100 < data.total}<a class="knapp liten" href="?side={data.page + 1}">Neste</a>{/if}
</div>
