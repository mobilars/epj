<script lang="ts">
	let { data } = $props();

	const kroner = (ore: number) => (ore / 100).toLocaleString('nb-NO', { style: 'currency', currency: 'NOK' });
	const klokke = (iso?: string) =>
		iso ? new Date(iso).toLocaleString('nb-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
</script>

<h1>Arbeidsflate</h1>

{#if data.emergencyAccess.length}
	<div class="varsel varsel-feil" role="alert">
		<strong>Aktiv nødrettstilgang</strong>
		<ul>
			{#each data.emergencyAccess as n (n.patientId)}
				<li>
					<a href="/pasienter/{n.patientId}">Pasient {n.patientId}</a> - utløper {klokke(n.expires_at)}.
					Begrunnelse: {n.justification}
				</li>
			{/each}
		</ul>
		Nødrettsoppslag gjennomgås av ledelsen, og pasienten skal informeres.
	</div>
{/if}

{#if data.outsideReceipt > 0}
	<div class="varsel varsel-advarsel">
		{data.outsideReceipt} sendte meldinger mangler applikasjonskvittering.
		<a href="/meldinger?filter=uten-kvittering">Se hvilke</a>
	</div>
{/if}

<!-- The cards, in the order the person or the practice arranged them. A
     card not in the layout is not drawn; its page is still where it was. -->
<div class="rutenett">
	{#each data.layout as card (card)}
		{#if card === 'timebok'}
			<section class="kort">
				<h2>Timeboken</h2>
				{#if data.appointments.length === 0}
					<p class="svak">Ingen kommende timer.</p>
				{:else}
					<ul class="tidslinje">
						{#each data.appointments as t (t.id)}
							<li>
								<strong>{klokke(t.start)}</strong>
								{#if t.patient}
									· <a href="/pasienter/{t.patient.id}">{t.patient.name}</a>
									<span class="svak">({t.patient.age} år)</span>
								{/if}
								<span class="merke">{t.status}</span>
								{#if t.description}<br /><span class="svak">{t.description}</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{:else if card === 'meldinger'}
			<section class="kort">
				<h2>Nye meldinger</h2>
				{#if data.messages.length === 0}
					<p class="svak">Ingen ubehandlede meldinger.</p>
				{:else}
					<ul class="tidslinje">
						{#each data.messages as m (m.id)}
							<li>
								<a href="/meldinger/{m.id}">{m.type}</a> fra {m.sender}<br />
								<span class="svak">{klokke(m.created_at)}</span>
							</li>
						{/each}
					</ul>
				{/if}
				<a class="knapp liten" href="/meldinger">Åpne innboks</a>
			</section>
		{:else if card === 'oppgjor'}
			<section class="kort">
				<h2>Oppgjør</h2>
				<p>
					<strong class="tall">{data.settlement.countKlare}</strong> regningskort er klare for innsending.<br />
					Samlet refusjon: <strong class="tall">{kroner(data.settlement.sumReimbursementOre)}</strong>
				</p>
				<a class="knapp liten" href="/oppgjor">Gå til oppgjør</a>
			</section>
		{/if}
	{/each}
</div>
<p class="svak liten"><a href="/innstillinger">Tilpass arbeidsflaten</a></p>
