<script lang="ts">
	let { data }: { data: { messages: { id: string; type: string; sender: string; created_at: string }[] } } = $props();

	const klokke = (iso: string) =>
		new Date(iso).toLocaleString('nb-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
</script>

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
