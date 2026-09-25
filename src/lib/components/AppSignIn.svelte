<script lang="ts">
	/**
	 * An app that cannot be framed until the user has signed in somewhere else.
	 *
	 * The app authenticates against an identity provider of its own, and an
	 * identity provider will not be framed: the login page carries
	 * X-Frame-Options, so the frame goes blank at the point where the user would
	 * have typed their credentials. The authorization endpoint itself renders
	 * nothing - it answers with a redirect - so the moment a session exists the
	 * same app passes through a frame untouched.
	 *
	 * So: sign in as a window, where the provider can draw a login form, an
	 * organisation choice or a step up in security level, and come back to the
	 * frame afterwards. Each visit mints its own launch through the record's own
	 * start route, so the window and the frame never share a single-use context.
	 *
	 * The window is opened with `noopener` on purpose. A handle would let us
	 * watch for it closing and close it ourselves, but it also hands a
	 * third-party app a live reference to the record's own window, which it can
	 * navigate. Coming back to the record is the signal we use instead: it costs
	 * a keystroke at worst and gives the app nothing.
	 */
	let { name, startUrl, frameUrl }: { name: string; startUrl: string; frameUrl: string } = $props();

	let started = $state(false);
	let framed = $state(false);

	function signIn(event: MouseEvent) {
		// Let the plain link do the work if there is no window to open one from,
		// so this works the same with scripting off.
		if (typeof window === 'undefined') return;
		event.preventDefault();
		window.open(startUrl, '_blank', 'noopener,width=560,height=840');
		started = true;
	}

	// Coming back to the record is how we know the user is done. Without a
	// handle on the window there is nothing to poll, and asking the browser for
	// one would give the app more than this is worth.
	$effect(() => {
		if (!started || framed) return;
		const back = () => {
			if (document.visibilityState === 'visible') framed = true;
		};
		window.addEventListener('focus', back);
		document.addEventListener('visibilitychange', back);
		return () => {
			window.removeEventListener('focus', back);
			document.removeEventListener('visibilitychange', back);
		};
	});
</script>

{#if framed}
	<iframe class="appramme" src={frameUrl} title={name} allow="clipboard-write"></iframe>
	<p class="svak omstart">
		Er rammen tom? Da varte ikke påloggingen.
		<button type="button" class="lenkeknapp" onclick={() => { framed = false; started = false; }}>
			Logg inn på nytt
		</button>
	</p>
{:else}
	<section class="kort">
		<h3>{name} krever egen pålogging</h3>
		<p class="svak">
			Appen logger deg inn hos sin egen identitetstjeneste, og den tjenesten lar seg ikke vise i
			en ramme. Påloggingen skjer derfor i et eget vindu. Du beholder pasienten du står i, og
			appen vises her når du er tilbake.
		</p>
		<p class="handlinger">
			<a class="knapp-primar" href={startUrl} target="_blank" rel="noopener" onclick={signIn}>
				{started ? `Åpne påloggingen på nytt` : `Logg inn og åpne ${name}`}
			</a>
			{#if started}
				<button type="button" class="knapp liten" onclick={() => (framed = true)}>
					Jeg er ferdig – vis appen her
				</button>
			{:else}
				<a class="knapp liten" href="?vis=ramme">Hopp over – vis appen her</a>
			{/if}
		</p>
	</section>
{/if}

<style>
	.appramme {
		width: 100%;
		height: min(86vh, 1100px);
		border: 1px solid var(--kant);
		border-radius: 8px;
		background: var(--flate);
	}

	.handlinger {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0;
	}

	.omstart {
		margin-top: 0.4rem;
		font-size: 0.8rem;
	}

	/* A button that reads as part of the sentence it sits in. */
	.lenkeknapp {
		width: auto;
		padding: 0;
		margin: 0;
		border: 0;
		background: none;
		color: var(--primar);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
