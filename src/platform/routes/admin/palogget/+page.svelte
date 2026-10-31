<script lang="ts">
	let { data, form } = $props();
</script>

<h2>Pålogget nå</h2>
<p class="svak">
	Økter som er i bruk akkurat nå. En som er pålogget på to maskiner, står her to ganger.
	Avslutter du en økt, må brukeren logge inn på nytt ved neste klikk.
</p>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.endedFor}<div class="varsel varsel-ok" role="status">Økten til {form.endedFor} er avsluttet.</div>{/if}

<p>
	<strong>{data.people}</strong> {data.people === 1 ? 'person' : 'personer'} i
	<strong>{data.sessions.length}</strong> {data.sessions.length === 1 ? 'økt' : 'økter'}.
</p>

{#if data.sessions.length === 0}
	<p class="svak">Ingen er pålogget.</p>
{:else}
	<div class="tabellramme">
		<table>
			<thead>
				<tr>
					<th>Bruker</th>
					<th>Innlogget</th>
					<th>Sist aktiv</th>
					<th>Metode</th>
					<th>Enhet</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.sessions as s (s.id)}
					<tr>
						<td>
							<strong>{s.name}</strong><br /><span class="svak mono">{s.username}</span>
							{#if s.current}<span class="merke merke-ok">Deg</span>{/if}
							{#if s.elevated}<span class="merke merke-advarsel" title="Har nylig bekreftet identiteten for nødrettstilgang">Forhøyet</span>{/if}
						</td>
						<td>{s.since}</td>
						<td>
							{#if s.idleMinutes < 2}Nå{:else}{s.idleMinutes} min siden{/if}
							<br /><span class="svak">{s.lastActive}</span>
						</td>
						<td>{s.method}</td>
						<td>{s.device}{#if s.ip}<br /><span class="svak mono">{s.ip}</span>{/if}</td>
						<td>
							{#if !s.current}
								<form method="POST" action="?/end">
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="liten fare">Avslutt økt</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.tabellramme {
		overflow-x: auto;
	}

	td form {
		margin: 0;
	}

	td button {
		width: auto;
		white-space: nowrap;
	}

	.merke {
		margin-left: 0.3rem;
	}
</style>
