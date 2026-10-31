<script lang="ts">
	/**
	 * Everything the record shows that the record did not make: SMART apps, and
	 * SFM's screen. Inside a frame an app can look exactly like a page of the
	 * record, while its data handling, its vendor and its answers are its own, so
	 * a clinician has to be able to see at a glance which of the two they are in.
	 *
	 * All frames go through here, so a new place to show an app cannot forget the
	 * marking. It is on unless the person has turned it off under Innstillinger,
	 * except for an app the platform owner has not approved, which is always marked.
	 *
	 * The app's name opens who made it and where it runs. A native popover, because
	 * the frame's rounded edge clips anything hanging off the strip inside it.
	 */
	import { page } from '$app/state';
	import { externalAppLabel, NOT_APPROVED, NOT_APPROVED_EXPLANATION } from '$lib/external-app';
	import type { HTMLIframeAttributes } from 'svelte/elements';

	interface AppDetails {
		clientId: string;
		publisher: string | null;
		contactEmail: string | null;
		host: string | null;
		approved: boolean;
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

	const details = $derived(
		clientId ? ((page.data.apps ?? []) as AppDetails[]).find((app) => app.clientId === clientId) : undefined
	);
	const unapproved = $derived(details?.approved === false);
	const marked = $derived(page.data.markExternalApps !== false || unapproved);
	const popoverId = $props.id();

	let nameButton = $state<HTMLButtonElement | null>(null);

	/** Opens just below the name, kept inside the window: a side panel sits at its right edge. */
	function placeBelowName(event: ToggleEvent) {
		if (event.newState !== 'open' || !nameButton) return;
		const popup = event.currentTarget as HTMLElement;
		const name = nameButton.getBoundingClientRect();
		popup.style.margin = '0';
		popup.style.top = `${name.bottom + 4}px`;
		popup.style.left = `max(0.5rem, min(${name.left}px, calc(100vw - 22rem - 0.5rem)))`;
	}
</script>

<div class="ekstern" class:merket={marked} class:ikke-godkjent={unapproved}>
	{#if marked}
		<div class="ekstern-stripe">
			{#if details}
				{#if unapproved}<span aria-hidden="true">⚠ </span>{/if}{externalAppLabel('')}<button type="button" class="appnavn" popovertarget={popoverId} bind:this={nameButton}>{title}</button>{#if unapproved}{` - ${NOT_APPROVED}`}{/if}
			{:else}
				{label ?? externalAppLabel(title)}
			{/if}
		</div>
		{#if details}
			<div id={popoverId} popover="auto" class="appinfo" onbeforetoggle={placeBelowName}>
				<div class="appinfo-topp">
					<h3>{title}</h3>
					<button type="button" class="liten" popovertarget={popoverId} popovertargetaction="hide">Lukk</button>
				</div>
				{#if unapproved}
					<p class="appinfo-advarsel"><strong>⚠ Ikke godkjent av plattformeier.</strong> {NOT_APPROVED_EXPLANATION}</p>
				{/if}
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

	/* Amber rather than the usual colour, so the difference shows without reading. */
	.ikke-godkjent.merket {
		border-color: var(--advarsel);
	}

	.ikke-godkjent .ekstern-stripe {
		background: var(--advarsel);
		color: var(--flate);
	}

	.appinfo-advarsel {
		margin: 0 0 0.5rem;
		padding: 0.5rem 0.6rem;
		background: var(--advarsel-svak);
		border-radius: var(--radius);
		font-size: 0.85rem;
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
		width: min(22rem, calc(100vw - 1rem));
		box-sizing: border-box;
	}

	.appinfo-topp {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
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
