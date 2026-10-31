<script lang="ts">
	/**
	 * Keyboard shortcuts for the record.
	 *
	 * The ones a clinician reaches for between patients: find a patient, jump to
	 * a tab, start a note. Single keys and `g` sequences, the pattern people
	 * know from mail and code-review tools, because they never collide with the
	 * browser's own Ctrl and Alt combinations.
	 *
	 * Never while typing: a key pressed in a field belongs to the field, so a
	 * note that mentions "n" does not open a new one. Keys pressed inside an
	 * app's frame never reach this window at all.
	 *
	 * Single-character shortcuts can be triggered by accident with speech
	 * input, so WCAG 2.1.4 asks that they can be switched off. That setting is
	 * under Innstillinger; with it off, this component draws nothing and
	 * listens to nothing.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';

	let dialog = $state<HTMLDialogElement | null>(null);
	let prefix: 'g' | null = null;
	let prefixTimer: ReturnType<typeof setTimeout> | null = null;

	// The patient whose record is open, if any. `/pasienter/ny` is the
	// registration form, not a patient.
	const patientId = $derived.by(() => {
		const id = page.url.pathname.match(/^\/pasienter\/([^/]+)/)?.[1];
		return id && id !== 'ny' ? id : null;
	});

	type Target = { key: string; href: string; label: string };

	const everywhere: Target[] = [
		{ key: 'a', href: '/', label: 'Arbeidsflaten' },
		{ key: 'p', href: '/pasienter', label: 'Pasienter' },
		{ key: 'm', href: '/meldinger', label: 'Meldinger' },
		{ key: 'i', href: '/innstillinger', label: 'Innstillinger' }
	];

	const inRecord = $derived<Target[]>(
		patientId
			? [
					{ key: 'o', href: `/pasienter/${patientId}`, label: 'Oversikt' },
					{ key: 'n', href: `/pasienter/${patientId}/notater`, label: 'Journalnotater' },
					{ key: 'l', href: `/pasienter/${patientId}/legemidler`, label: 'Legemidler' }
				]
			: []
	);

	function clearPrefix() {
		prefix = null;
		if (prefixTimer) clearTimeout(prefixTimer);
		prefixTimer = null;
	}

	function typing(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
	}

	async function goAndFocus(href: string, id: string) {
		if (page.url.pathname !== href) await goto(href);
		await tick();
		const field = document.getElementById(id);
		field?.scrollIntoView({ block: 'center' });
		field?.focus();
	}

	/** The search field on this page, or the patient search if there is none. */
	function search() {
		const field = document.querySelector<HTMLInputElement>('[data-shortcut-search]:not([hidden])');
		if (field && field.offsetParent !== null) {
			field.focus();
			field.select();
		} else {
			goAndFocus('/pasienter', 'sok');
		}
	}

	export function openHelp() {
		dialog?.showModal();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		if (typing(event.target) || dialog?.open) return;

		if (prefix === 'g') {
			clearPrefix();
			const target = [...inRecord, ...everywhere].find((t) => t.key === event.key.toLowerCase());
			if (target) {
				event.preventDefault();
				goto(target.href);
			}
			return;
		}

		switch (event.key) {
			case '?':
				event.preventDefault();
				openHelp();
				return;
			case '/':
				event.preventDefault();
				search();
				return;
			case 'g':
				prefix = 'g';
				prefixTimer = setTimeout(clearPrefix, 1500);
				return;
			case 'n':
				if (patientId) {
					event.preventDefault();
					goAndFocus(`/pasienter/${patientId}/notater`, 'subjektivt');
				}
				return;
		}
	}
</script>

<svelte:window {onkeydown} />

<button type="button" class="lenkeknapp" onclick={openHelp} aria-haspopup="dialog">Hurtigtaster</button>

<dialog bind:this={dialog} class="hurtigtaster" aria-labelledby="hurtigtaster-tittel">
	<div class="rad-mellom">
		<h2 id="hurtigtaster-tittel">Hurtigtaster</h2>
		<form method="dialog"><button type="submit" class="liten">Lukk</button></form>
	</div>
	<p class="svak">Virker når markøren ikke står i et tekstfelt. Kan slås av under Innstillinger.</p>

	<table>
		<tbody>
			<tr><td><kbd>/</kbd></td><td>Søk – i notatene når du står der, ellers etter pasient</td></tr>
			<tr><td><kbd>?</kbd></td><td>Vis denne oversikten</td></tr>
			{#each everywhere as t (t.key)}
				<tr><td><kbd>g</kbd> <kbd>{t.key}</kbd></td><td>{t.label}</td></tr>
			{/each}
		</tbody>
	</table>

	<h3>I en pasientjournal</h3>
	<table>
		<tbody>
			<tr><td><kbd>n</kbd></td><td>Nytt journalnotat</td></tr>
			<tr><td><kbd>g</kbd> <kbd>o</kbd></td><td>Oversikt</td></tr>
			<tr><td><kbd>g</kbd> <kbd>n</kbd></td><td>Journalnotater</td></tr>
			<tr><td><kbd>g</kbd> <kbd>l</kbd></td><td>Legemidler</td></tr>
		</tbody>
	</table>
</dialog>

<style>
	.lenkeknapp {
		width: auto;
		padding: 0;
		margin: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.hurtigtaster {
		max-width: min(32rem, 92vw);
		border: 1px solid var(--kant);
		border-radius: var(--radius);
		background: var(--flate);
		color: var(--tekst);
		padding: 1rem 1.25rem;
	}

	.hurtigtaster::backdrop {
		background: rgb(0 0 0 / 35%);
	}

	.hurtigtaster h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.hurtigtaster h3 {
		font-size: 0.95rem;
		margin: 1rem 0 0.3rem;
	}

	.hurtigtaster form {
		margin: 0;
	}

	.hurtigtaster td:first-child {
		white-space: nowrap;
		width: 6rem;
	}

	kbd {
		display: inline-block;
		min-width: 1.4em;
		padding: 0.05rem 0.35rem;
		border: 1px solid var(--kant-sterk);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--flate-2);
		font-family: var(--mono);
		font-size: 0.85em;
		text-align: center;
	}
</style>
