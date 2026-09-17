<script lang="ts">
	/**
	 * Arranges the cards of a surface: which are shown, and in what order.
	 *
	 * A plain form. One checkbox and one number per card, and a save button -
	 * it works with JavaScript off, which the record promises everywhere else,
	 * and it makes the arrangement a thing that is posted and stored rather
	 * than a drag that has to be watched. A second button clears the person's
	 * own arrangement and goes back to whatever the level above decided.
	 */
	let {
		cards,
		layout,
		source,
		action,
		resetAction,
		resetLabel = 'Bruk virksomhetens oppsett',
		surface
	}: {
		cards: { id: string; title: string; description: string }[];
		layout: string[];
		source: 'bruker' | 'virksomhet' | 'standard';
		action: string;
		resetAction?: string;
		resetLabel?: string;
		surface: string;
	} = $props();

	const position = (id: string) => {
		const i = layout.indexOf(id);
		return i === -1 ? layout.length + cards.findIndex((c) => c.id === id) + 1 : i + 1;
	};
	const shown = (id: string) => layout.includes(id);
	const ordered = $derived([...cards].sort((a, b) => position(a.id) - position(b.id)));
</script>

<form method="POST" {action} class="oppsett">
	<input type="hidden" name="flate" value={surface} />
	<table>
		<thead>
			<tr>
				<th>Vis</th>
				<th>Rekkefølge</th>
				<th>Kort</th>
			</tr>
		</thead>
		<tbody>
			{#each ordered as card (card.id)}
				<tr>
					<td>
						<input type="checkbox" name="vis:{card.id}" value="ja" checked={shown(card.id)} aria-label="Vis {card.title}" />
					</td>
					<td>
						<input
							type="number"
							name="rekkefolge:{card.id}"
							value={position(card.id)}
							min="1"
							max={cards.length}
							style="width: 4.5rem"
							aria-label="Rekkefølge for {card.title}"
						/>
					</td>
					<td>
						<strong>{card.title}</strong>
						<span class="svak"> · {card.description}</span>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<div class="rad">
		<button type="submit" class="primar">Lagre</button>
		{#if resetAction && source === 'bruker'}
			<button type="submit" formaction={resetAction} class="liten">{resetLabel}</button>
		{/if}
		<span class="svak liten">
			{#if source === 'bruker'}Ditt eget oppsett.{:else if source === 'virksomhet'}Virksomhetens oppsett.{:else}Standardoppsettet.{/if}
		</span>
	</div>
</form>

<style>
	.oppsett td { vertical-align: middle; }
	.oppsett input[type='checkbox'] { width: auto; }
</style>
