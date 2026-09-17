<script lang="ts">
	let { data, form } = $props();
	const g = $derived(data.grupper);
	// A card set aside stays aside for this view; the service has been told.
	const visible = $derived((data.cds?.cards ?? []).filter((c) => (c.uuid ?? c.summary) !== form?.cdsDismissed));
</script>

{#if form?.cdsDone}<div class="varsel varsel-ok" role="status">{form.cdsDone}</div>{/if}
{#if form?.cdsError}<div class="varsel varsel-feil" role="alert">{form.cdsError}</div>{/if}

{#if visible.length}
	<!-- Advice from CDS Hooks services. A card says something; a suggestion
	     on it proposes something the clinician can do with one press - and
	     that press is the clinician's write, judged like any other. Nothing
	     here lets a service write or stop anyone. -->
	<section class="cds-kort" aria-label="Beslutningsstøtte">
		{#each visible as card, i (card.uuid ?? i)}
			<article class="varsel varsel-{card.indicator === 'critical' ? 'feil' : card.indicator === 'warning' ? 'advarsel' : 'info'}">
				<strong>{card.summary}</strong>
				{#if card.detail}<p>{card.detail}</p>{/if}
				{#if card.suggestions?.length}
					<div class="rad cds-forslag">
						{#each card.suggestions as suggestion (suggestion.uuid ?? suggestion.label)}
							<form method="POST" action="?/acceptSuggestion">
								<input type="hidden" name="card" value={JSON.stringify(card)} />
								<input type="hidden" name="suggestion" value={JSON.stringify(suggestion)} />
								<button
									type="submit"
									class="liten"
									class:primar={suggestion.isRecommended}
									title={suggestion.actions?.map((a) => a.description).filter(Boolean).join(' ')}
								>
									{suggestion.label}
								</button>
							</form>
						{/each}
					</div>
				{/if}
				{#if card.links?.length}
					<p>
						{#each card.links as link (link.url)}
							<a href={link.url} rel="noopener" class="knapp liten">{link.label}</a>
						{/each}
					</p>
				{/if}
				<div class="rad-mellom">
					<small class="svak">
						{card.serviceTitle ?? card.source?.label ?? 'Beslutningsstøtte'} · råd, ikke en avgjørelse
					</small>
					<form method="POST" action="?/dismissCard" class="rad">
						<input type="hidden" name="card" value={JSON.stringify(card)} />
						{#if card.overrideReasons?.length}
							<select name="reason" aria-label="Grunn">
								<option value="">Sett til side</option>
								{#each card.overrideReasons as r (r.code)}<option value={r.code}>{r.display ?? r.code}</option>{/each}
							</select>
						{/if}
						<button type="submit" class="liten">Sett til side</button>
					</form>
				</div>
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
