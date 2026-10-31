<script lang="ts">
	/**
	 * SFM's own medication screen, in a frame in the Legemidler tab.
	 *
	 * The patient's name and number never enter the frame: the record's banner
	 * above says whose record this is, as NHN requires, and SFM only ever sees a
	 * ticket. This needs scripting, because SFM's login is a conversation with the
	 * page. Without it the page says so.
	 */
	import { onMount } from 'svelte';
	import { createHandshake, type SfmState } from '$lib/sfm/handshake';
	import ExternalFrame from '$lib/components/ExternalFrame.svelte';

	let { patientId, simulated = false }: { patientId: string; simulated?: boolean } = $props();

	/** A little more than NHN's lower bound for how long the one-time code lives. */
	const LOAD_TIMEOUT_MS = 30_000;
	/** NHN's sample pings at this rate. The server only calls SFM when the token changed. */
	const REFRESH_MS = 240_000;

	const REASONS: Record<string, string> = {
		'needs-helseid': 'SFM krever at du er logget inn med HelseID. Logg ut og inn igjen med HelseID.',
		'no-national-id':
			'Pasienten har ikke et gyldig fødselsnummer eller D-nummer, og kan derfor ikke åpnes i SFM. Rett nummeret under Pasientopplysninger.',
		unavailable: 'SFM svarte ikke. Prøv igjen om litt.'
	};

	let frame = $state<HTMLIFrameElement | null>(null);
	let src = $state<string | null>(null);
	let sfmState = $state<SfmState>('loading');
	let problem = $state<string | null>(null);

	let handshake: ReturnType<typeof createHandshake> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const MESSAGES: Record<SfmState, string> = {
		loading: 'Starter SFM …',
		'signing-in': 'Logger inn i SFM …',
		opening: 'Åpner pasienten i SFM …',
		ready: '',
		failed: ''
	};

	function clearTimer() {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function fail(message: string) {
		clearTimer();
		src = null;
		handshake = null;
		sfmState = 'failed';
		problem = message;
	}

	async function open() {
		problem = null;
		sfmState = 'loading';
		src = null;
		handshake = null;
		try {
			const response = await fetch(`/pasienter/${encodeURIComponent(patientId)}/legemidler/sfm-sesjon`, { method: 'POST' });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				fail(REASONS[body.reason] ?? REASONS.unavailable);
				return;
			}
			const portalOrigin = new URL(body.portalUrl, location.href).origin;
			handshake = createHandshake({
				portalOrigin,
				login: body.login,
				ticket: body.ticket,
				post: (message, target) => frame?.contentWindow?.postMessage(message, target),
				onState: (next) => {
					sfmState = next;
					if (next === 'ready') clearTimer();
					if (next === 'failed') fail('SFM kunne ikke åpne pasienten. Prøv igjen.');
				}
			});
			src = body.portalUrl;
			clearTimer();
			timer = setTimeout(() => fail('SFM svarte ikke innen rimelig tid. Prøv igjen.'), LOAD_TIMEOUT_MS);
		} catch {
			fail(REASONS.unavailable);
		}
	}

	async function keepAlive() {
		if (sfmState !== 'ready') return;
		const response = await fetch('/sfm/oppfrisk', { method: 'POST' }).catch(() => null);
		if (response && !response.ok) fail(REASONS['needs-helseid']);
	}

	onMount(() => {
		const onMessage = (event: MessageEvent) => {
			handshake?.receive({
				origin: event.origin,
				fromFrame: event.source === frame?.contentWindow,
				data: event.data
			});
		};
		window.addEventListener('message', onMessage);
		const refresh = setInterval(keepAlive, REFRESH_MS);
		open();
		return () => {
			window.removeEventListener('message', onMessage);
			clearInterval(refresh);
			clearTimer();
		};
	});
</script>

<noscript>
	<div class="varsel varsel-advarsel">Legemiddelmodulen SFM krever JavaScript.</div>
</noscript>

{#if problem}
	<div class="varsel varsel-feil" role="alert">
		{problem}
		<button type="button" class="liten" onclick={open}>Prøv igjen</button>
	</div>
{:else if sfmState !== 'ready'}
	<p class="svak" role="status">{MESSAGES[sfmState]}</p>
{/if}

{#if src}
	<!-- Not a SMART app, but just as much not the record's own. The label must not
	     claim SFM while it is only the local simulator. -->
	<ExternalFrame
		bind:frame
		class="appramme appramme-full sfm"
		label={simulated ? 'SFM-simulator – ikke koblet til Norsk helsenett' : 'Sentral forskrivningsmodul – tjeneste fra Norsk helsenett'}
		{src}
		title="Sentral forskrivningsmodul"
		allow="clipboard-write"
		referrerpolicy="no-referrer"
		data-state={sfmState}
	/>
{/if}

