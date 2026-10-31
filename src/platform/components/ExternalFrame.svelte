<script lang="ts">
	/**
	 * Everything the record shows that the record did not make: SMART apps, and
	 * SFM's screen. Inside a frame an app can look exactly like a page of the
	 * record, while its data handling, its vendor and its answers are its own, so
	 * a clinician has to be able to see at a glance which of the two they are in.
	 *
	 * All frames go through here, so a new place to show an app cannot forget the
	 * marking. It is on unless the person has turned it off under Innstillinger.
	 */
	import { page } from '$app/state';
	import { externalAppLabel } from '$lib/external-app';
	import type { HTMLIframeAttributes } from 'svelte/elements';

	let {
		frame = $bindable(null),
		label,
		title,
		class: frameClass = 'appramme',
		...attributes
	}: HTMLIframeAttributes & { frame?: HTMLIFrameElement | null; label?: string; title: string; class?: string } = $props();

	const marked = $derived(page.data.markExternalApps !== false);
</script>

<div class="ekstern" class:merket={marked}>
	{#if marked}<div class="ekstern-stripe">{label ?? externalAppLabel(title)}</div>{/if}
	<iframe bind:this={frame} class={frameClass} {title} {...attributes}></iframe>
</div>

<style>
	.merket {
		border: 3px solid var(--external-app);
		border-radius: 8px;
		overflow: hidden;
	}

	.ekstern-stripe {
		background: var(--external-app);
		color: var(--on-external-app);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1.2;
		padding: 0.15rem 0.5rem 0.25rem;
	}

	/* The frame's own edge would only be a second line inside the coloured one. */
	.merket iframe {
		display: block;
		border: 0;
		border-radius: 0;
	}
</style>
