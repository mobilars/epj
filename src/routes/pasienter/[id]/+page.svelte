<script lang="ts">
	let { data } = $props();
	const g = $derived(data.grupper);
</script>

{#if data.cds?.cards?.length}
	<!-- Advice from CDS Hooks services. Cards say something; they never do
	     anything. Nothing here can write to the record or stop the user. -->
	<section class="cds-kort" aria-label="Beslutningsstøtte">
		{#each data.cds.cards as card, i (i)}
			<article class="varsel varsel-{card.indicator === 'critical' ? 'feil' : card.indicator === 'warning' ? 'advarsel' : 'info'}">
				<strong>{card.summary}</strong>
				{#if card.detail}<p>{card.detail}</p>{/if}
				{#if card.links?.length}
					<p>
						{#each card.links as link (link.url)}
							<a href={link.url} rel="noopener" class="knapp liten">{link.label}</a>
						{/each}
					</p>
				{/if}
				<small class="svak">
					{card.serviceTitle ?? card.source?.label ?? 'Beslutningsstøtte'} · råd, ikke en avgjørelse
				</small>
			</article>
		{/each}
	</section>
{/if}
{#if data.cds?.failed?.length}
	<p class="svak liten">
		Beslutningsstøtte svarte ikke: {data.cds.failed.join(', ')}. Journalen er vist uten.
	</p>
{/if}


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
