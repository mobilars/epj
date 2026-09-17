<script lang="ts">
	/**
	 * Picks an ICPC-2 code by typing a code or a word.
	 *
	 * What is posted is only the code, in the field named by `name`; the record
	 * takes the official name from the Directorate's table when it files the
	 * diagnosis, so nothing typed here can end up as the name of a diagnosis.
	 *
	 * Works without JavaScript: the visible input is the code field, and a
	 * clinician who knows the code can type it and submit. With JavaScript, it
	 * searches as they type and lets them pick from the official names.
	 */
	let { name, value = '', label = 'Kode eller søkeord' }: { name: string; value?: string; label?: string } = $props();

	type Hit = { code: string; display: string; chapter: string | null; icd10: string | null; inclusion: string | null };

	// svelte-ignore state_referenced_locally -- the initial code is all that is wanted; the field owns it from here
	let query = $state(value);
	let chosen = $state<Hit | null>(null);
	let hits = $state<Hit[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const listId = `icpc2-${Math.random().toString(36).slice(2, 8)}`;

	async function search(q: string) {
		if (q.trim().length < 2) {
			hits = [];
			open = false;
			return;
		}
		const response = await fetch(`/api/kodeverk/icpc2?q=${encodeURIComponent(q)}`);
		if (!response.ok) return;
		const body = (await response.json()) as { results: Hit[] };
		hits = body.results;
		open = hits.length > 0;
		active = hits.length ? 0 : -1;
	}

	function onInput() {
		chosen = null;
		clearTimeout(timer);
		timer = setTimeout(() => search(query), 150);
	}

	function choose(hit: Hit) {
		chosen = hit;
		query = hit.code;
		open = false;
	}

	function onKey(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'ArrowDown') {
			active = Math.min(active + 1, hits.length - 1);
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			active = Math.max(active - 1, 0);
			e.preventDefault();
		} else if (e.key === 'Enter' && active >= 0) {
			choose(hits[active]);
			e.preventDefault();
		} else if (e.key === 'Escape') {
			open = false;
		}
	}
</script>

<div class="icpc2">
	<label for="{listId}-input">{label}</label>
	<input
		id="{listId}-input"
		{name}
		bind:value={query}
		oninput={onInput}
		onkeydown={onKey}
		onfocus={() => hits.length && (open = true)}
		onblur={() => setTimeout(() => (open = false), 120)}
		autocomplete="off"
		role="combobox"
		aria-expanded={open}
		aria-controls={listId}
		aria-autocomplete="list"
		placeholder="K86 eller «hypertensjon»"
		style="max-width: 24rem"
	/>
	{#if chosen}
		<p class="valgt">
			<strong>{chosen.code}</strong> {chosen.display}
			{#if chosen.icd10}<span class="svak"> · ICD-10 {chosen.icd10}</span>{/if}
		</p>
	{/if}
	{#if open}
		<ul id={listId} class="treff" role="listbox">
			{#each hits as hit, i (hit.code)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					role="option"
					aria-selected={i === active}
					class:aktiv={i === active}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => choose(hit)}
				>
					<span class="mono kode">{hit.code}</span>
					<span class="navn">{hit.display}</span>
					{#if hit.inclusion}<span class="svak inkl">{hit.inclusion}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.icpc2 { position: relative; }
	.valgt { margin: 0.35rem 0 0; font-size: 0.92rem; }
	.treff {
		position: absolute;
		z-index: 50;
		list-style: none;
		margin: 0.2rem 0 0;
		padding: 0.25rem;
		width: min(36rem, 100%);
		max-height: 18rem;
		overflow-y: auto;
		background: var(--flate);
		border: 1px solid var(--kant);
		border-radius: var(--radius);
		box-shadow: var(--skygge);
	}
	.treff li {
		display: grid;
		grid-template-columns: 3.2rem 1fr;
		gap: 0 0.5rem;
		padding: 0.35rem 0.5rem;
		border-radius: 4px;
		cursor: pointer;
	}
	.treff li:hover, .treff li.aktiv { background: var(--primar-svak); }
	.kode { font-weight: 600; }
	.inkl {
		grid-column: 2;
		font-size: 0.78rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
