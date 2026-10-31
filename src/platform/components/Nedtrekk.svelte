<script lang="ts">
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { apenMeny } from './open-menu.svelte';

	/**
	 * A menu that hangs off the bar it sits in.
	 *
	 * Only one is ever open: the open one is named in a value the whole page
	 * shares, so opening this closes whatever was open before without either
	 * menu knowing about the other. It also closes on Escape, on a press
	 * outside it, and once a link inside it has been followed - the three ways a
	 * person expects to be rid of a menu.
	 */
	let {
		etikett,
		knappeklasse = 'fanelenke',
		ariaLabel,
		aktiv = false,
		children
	}: {
		etikett: string;
		knappeklasse?: string;
		ariaLabel?: string;
		aktiv?: boolean;
		children: Snippet;
	} = $props();

	const id = Symbol('nedtrekk');
	const apen = $derived(apenMeny.id === id);
	let rot = $state<HTMLElement | null>(null);

	function veksle() {
		apenMeny.id = apen ? null : id;
	}

	function utenfor(event: PointerEvent) {
		if (!apen) return;
		if (rot && event.target instanceof Node && rot.contains(event.target)) return;
		apenMeny.id = null;
	}

	afterNavigate(() => {
		if (apen) apenMeny.id = null;
	});
</script>

<svelte:window
	onpointerdown={utenfor}
	onkeydown={(e) => {
		if (e.key === 'Escape' && apen) apenMeny.id = null;
	}}
/>

<div class="nedtrekk" bind:this={rot}>
	<button
		type="button"
		class={knappeklasse}
		aria-expanded={apen}
		aria-haspopup="true"
		aria-label={ariaLabel}
		aria-current={aktiv ? 'page' : undefined}
		onclick={veksle}
	>
		{etikett}
	</button>
	{#if apen}
		<div class="nedtrekk-panel">
			{@render children()}
		</div>
	{/if}
</div>
