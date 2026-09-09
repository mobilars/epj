<script lang="ts">
	let { data } = $props();

	const kroner = (ore: number) => (ore / 100).toLocaleString('nb-NO', { style: 'currency', currency: 'NOK' });
	const klokke = (iso?: string) =>
		iso ? new Date(iso).toLocaleString('nb-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
</script>

<h1>Arbeidsflate</h1>

{#if data.nodrett.length}
	<div class="varsel varsel-feil" role="alert">
		<strong>Aktiv nødrettstilgang</strong>
		<ul>
			{#each data.nodrett as n (n.patientId)}
				<li>
					<a href="/pasienter/{n.patientId}">Pasient {n.patientId}</a> - utløper {klokke(n.utloper)}.
					Begrunnelse: {n.begrunnelse}
				</li>
			{/each}
		</ul>
		Nødrettsoppslag gjennomgås av ledelsen, og pasienten skal informeres.
	</div>
{/if}

{#if data.uteKvittering > 0}
	<div class="varsel varsel-advarsel">
		{data.uteKvittering} sendte meldinger mangler applikasjonskvittering.
		<a href="/meldinger?filter=uten-kvittering">Se hvilke</a>
	</div>
{/if}

<div class="rutenett">
	<section class="kort">
		<h2>Timeboken</h2>
		{#if data.timer.length === 0}
			<p class="svak">Ingen kommende timer.</p>
		{:else}
			<ul class="tidslinje">
				{#each data.timer as t (t.id)}
					<li>
						<strong>{klokke(t.start)}</strong>
						{#if t.pasient}
							· <a href="/pasienter/{t.pasient.id}">{t.pasient.navn}</a>
							<span class="svak">({t.pasient.alder} år)</span>
						{/if}
						<span class="merke">{t.status}</span>
						{#if t.beskrivelse}<br /><span class="svak">{t.beskrivelse}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="kort">
		<h2>Nye meldinger</h2>
		{#if data.meldinger.length === 0}
			<p class="svak">Ingen ubehandlede meldinger.</p>
		{:else}
			<ul class="tidslinje">
				{#each data.meldinger as m (m.id)}
					<li>
						<a href="/meldinger/{m.id}">{m.type}</a> fra {m.avsender}<br />
						<span class="svak">{klokke(m.opprettet)}</span>
					</li>
				{/each}
			</ul>
		{/if}
		<a class="knapp liten" href="/meldinger">Åpne innboks</a>
	</section>

	<section class="kort">
		<h2>Oppgjør</h2>
		<p>
			<strong class="tall">{data.oppgjor.antallKlare}</strong> regningskort er klare for innsending.<br />
			Samlet refusjon: <strong class="tall">{kroner(data.oppgjor.sumRefusjonOre)}</strong>
		</p>
		<a class="knapp liten" href="/oppgjor">Gå til oppgjør</a>
	</section>
</div>
