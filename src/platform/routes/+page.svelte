<script lang="ts">
	import { workspaceCards } from '$apps/slots';
	let { data } = $props();

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

{#each data.notices as notice (notice.href)}
	<div class="varsel varsel-advarsel">
		{notice.text}
		<a href={notice.href}>{notice.linkText}</a>
	</div>
{/each}

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
		{:else if workspaceCards[card] && data.cardData[card]}
			{@const Card = workspaceCards[card]}
			<Card data={data.cardData[card]} />
		{/if}
	{/each}
</div>
<p class="svak liten"><a href="/innstillinger">Tilpass arbeidsflaten</a></p>
