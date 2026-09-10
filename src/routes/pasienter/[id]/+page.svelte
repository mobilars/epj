<script lang="ts">
	let { data } = $props();
	const g = $derived(data.grupper);
</script>

{#if !g}
	<p class="svak">Journalinnholdet vises når du har tilgang.</p>
{:else}
	<div class="rutenett">
		<section class="kort">
			<h2>Diagnoser og problemer</h2>
			{#if g.diagnoses.length === 0}
				<p class="svak">Ingen registrerte diagnoser.</p>
			{:else}
				<table>
					<thead><tr><th>Diagnose</th><th>Kode</th><th>Status</th></tr></thead>
					<tbody>
						{#each g.diagnoses as d (d.id)}
							<tr>
								<td>{d.text}</td>
								<td class="mono">{d.code}</td>
								<td><span class="merke" class:merke-ok={d.status === 'Aktiv'}>{d.status}</span></td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<section class="kort">
			<h2>Kritisk informasjon</h2>
			{#if g.allergier.length === 0}
				<p class="svak">Ingen registrerte allergier eller intoleranser.</p>
			{:else}
				<ul>
					{#each g.allergier as a (a.id)}
						<li>
							<strong>{a.text}</strong>
							{#if a.kritikalitet === 'high'}<span class="merke merke-fare">Høy kritikalitet</span>{/if}
							<span class="svak">{a.registered_at}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="kort">
			<h2>Legemidler i bruk</h2>
			{#if g.medications.length === 0}
				<p class="svak">Ingen aktive resepter.</p>
			{:else}
				<ul>
					{#each g.medications as m (m.id)}
						<li><strong>{m.name}</strong><br /><span class="svak">{m.dosage}</span></li>
					{/each}
				</ul>
			{/if}
			<a class="knapp liten" href="/pasienter/{data.patientId}/legemidler">Åpne legemiddelliste</a>
		</section>

		<section class="kort">
			<h2>Siste målinger og prøvesvar</h2>
			{#if g.malinger.length === 0}
				<p class="svak">Ingen registrerte målinger.</p>
			{:else}
				<table>
					<thead><tr><th>Måling</th><th class="hoyre">Verdi</th><th>Tidspunkt</th></tr></thead>
					<tbody>
						{#each g.malinger as m (m.id)}
							<tr><td>{m.name}</td><td class="hoyre tall">{m.value}</td><td class="svak">{m.timestamp}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<section class="kort">
			<h2>Siste journalnotater</h2>
			{#if g.notes.length === 0}
				<p class="svak">Ingen notater.</p>
			{:else}
				<ul class="tidslinje">
					{#each g.notes as n (n.id)}
						<li><strong>{n.title}</strong><br /><span class="svak">{n.date} · {n.forfatter}</span></li>
					{/each}
				</ul>
			{/if}
			<a class="knapp liten" href="/pasienter/{data.patientId}/notater">Alle notater</a>
		</section>

		<section class="kort">
			<h2>Kontakter</h2>
			{#if g.kontakter.length === 0}
				<p class="svak">Ingen registrerte kontakter.</p>
			{:else}
				<ul class="tidslinje">
					{#each g.kontakter as k (k.id)}
						<li>{k.date} · {k.type || 'Konsultasjon'} <span class="merke">{k.status}</span></li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if g.vaksiner.length}
			<section class="kort">
				<h2>Vaksiner</h2>
				<ul>
					{#each g.vaksiner as v (v.id)}<li>{v.name} <span class="svak">{v.date}</span></li>{/each}
				</ul>
			</section>
		{/if}
	</div>
{/if}
