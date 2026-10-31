<script lang="ts">
	/**
	 * Everything the record shows that the record did not make: SMART apps, and
	 * SFM's screen. Inside a frame an app can look exactly like a page of the
	 * record, while its data handling, its vendor and its answers are its own, so
	 * a clinician has to be able to see at a glance which of the two they are in.
	 *
	 * All frames go through here, so a new place to show an app cannot forget the
	 * marking. It is on unless the person has turned it off under Innstillinger.
	 *
	 * The app's name opens who made it and where it runs. A native popover, because
	 * the frame's rounded edge clips anything hanging off the strip inside it.
	 */
	import { page } from '$app/state';
	import { externalAppLabel } from '$lib/external-app';
	import type { HTMLIframeAttributes } from 'svelte/elements';

	interface AppDetails {
		clientId: string;
		publisher: string | null;
		contactEmail: string | null;
		host: string | null;
	}

	let {
		frame = $bindable(null),
		label,
		title,
		clientId,
		class: frameClass = 'appramme',
		...attributes
	}: HTMLIframeAttributes & {
		frame?: HTMLIFrameElement | null;
		label?: string;
		title: string;
		/** The app's id, for the details behind its name. SFM is not a registered app. */
		clientId?: string;
		class?: string;
	} = $props();

	const marked = $derived(page.data.markExternalApps !== false);
	const details = $derived(
		clientId ? ((page.data.apps ?? []) as AppDetails[]).find((app) => app.clientId === clientId) : undefined
	);
	const popoverId = $props.id();
</script>

<div class="ekstern" class:merket={marked}>
	{#if marked}
		<div class="ekstern-stripe">
			{#if details}
				{externalAppLabel('')}<button type="button" class="appnavn" popovertarget={popoverId}>{title}</button>
			{:else}
				{label ?? externalAppLabel(title)}
			{/if}
		</div>
		{#if details}
			<div id={popoverId} popover="auto" class="appinfo">
				<h3>{title}</h3>
				<dl>
					<dt>Laget av</dt>
					<dd>
						{details.publisher ?? 'Ikke oppgitt'}
						{#if details.contactEmail}<br /><a href="mailto:{details.contactEmail}">{details.contactEmail}</a>{/if}
					</dd>
					<dt>Kjører på</dt>
					<dd class="mono">{details.host ?? 'Ikke oppgitt'}</dd>
					<dt>App-id</dt>
					<dd class="mono">{details.clientId}</dd>
				</dl>
			</div>
		{/if}
	{/if}
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

	.appnavn {
		all: unset;
		cursor: pointer;
		text-decoration: underline;
	}

	.appnavn:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 1px;
	}

	.appinfo {
		background: var(--flate);
		color: inherit;
		border: 1px solid var(--kant);
		border-radius: var(--radius);
		box-shadow: var(--skygge);
		padding: 1rem 1.15rem;
		max-width: 26rem;
	}

	.appinfo h3 {
		margin: 0 0 0.5rem;
	}

	.appinfo dl {
		margin: 0;
	}

	.appinfo dt {
		font-size: 0.8rem;
		color: var(--tekst-svak);
		margin-top: 0.5rem;
	}

	.appinfo dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	/* The frame's own edge would only be a second line inside the coloured one. */
	.merket iframe {
		display: block;
		border: 0;
		border-radius: 0;
	}
</style>
