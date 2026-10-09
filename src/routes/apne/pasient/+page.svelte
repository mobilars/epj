<script lang="ts">
	import { onMount } from 'svelte';
	let { data, form } = $props();

	// What the server said, with an action's answer taking over from the load's.
	const view = $derived((form?.state ?? data.state) as string);

	let resolveForm = $state<HTMLFormElement | null>(null);
	let numberField = $state<HTMLInputElement | null>(null);
	// The fragment held nothing this page can use.
	let nothingToOpen = $state(false);

	onMount(() => {
		// The fragment may hold a national identity number. Take it out of the
		// address bar and out of this history entry before anything else, whatever
		// state the page is in - including when the user is not signed in.
		const hash = location.hash;
		if (hash) history.replaceState(history.state, '', location.pathname + location.search);

		if (data.state !== 'fragment' || form) return;
		const number = /^#(?:fnr|fodselsnummer)=(\d{11})$/.exec(hash)?.[1];
		if (number && resolveForm && numberField) {
			numberField.value = number;
			resolveForm.submit();
		} else {
			nothingToOpen = true;
		}
	});
</script>

<svelte:head>
	<title>Åpne pasient</title>
	<!-- The address may name a patient. It has no business in a search index or
	     in the Referer of anything this page links to. -->
	<meta name="robots" content="noindex" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<section class="kort apne">
	{#if view === 'signed-out'}
		<h1>Du er ikke logget inn</h1>
		<p>
			Journalen åpner bare en pasient fra et annet program når du allerede er logget inn med
			HelseID.
		</p>
		<p><a class="knapp-primar" href={data.loginUrl ?? '/logg-inn'}>Logg inn med HelseID</a></p>
		<p class="svak">Åpne pasienten på nytt fra det andre programmet når du er inne, hvis den ikke kommer opp av seg selv.</p>
	{:else if view === 'weak-login'}
		<h1>Krever HelseID</h1>
		<p>
			Du er logget inn, men ikke med HelseID. Lenker fra andre programmer åpner bare journalen
			for en HelseID-pålogging.
		</p>
		<p><a class="knapp" href="/pasienter">Søk opp pasienten selv</a></p>
	{:else if view === 'no-clinical-access'}
		<h1>Ingen tilgang</h1>
		<p>Rollen din har ikke tilgang til pasientopplysninger.</p>
	{:else if view === 'identity-in-query'}
		<h1>Fødselsnummer hører ikke hjemme i adressen</h1>
		<p>
			Lenken hadde et fødselsnummer i spørredelen av adressen. Den delen blir skrevet i logger
			underveis, så journalen åpner ikke pasienten på den måten.
		</p>
		<p class="svak">
			Til den som har satt opp integrasjonen: bruk journalens pasient-id
			(<span class="mono">/apne/pasient?id=…</span>), eller legg fødselsnummeret etter
			<span class="mono">#</span> (<span class="mono">/apne/pasient#fnr=…</span>). Det som står
			etter <span class="mono">#</span>, sendes aldri til en tjener.
		</p>
		<p><a class="knapp" href="/pasienter">Søk opp pasienten selv</a></p>
	{:else if view === 'bad-id'}
		<h1>Ugyldig pasient-id</h1>
		<p>Lenken inneholder en id journalen ikke kjenner igjen som en pasient-id.</p>
		<p><a class="knapp" href="/pasienter">Søk opp pasienten selv</a></p>
	{:else if view === 'bad-number'}
		<h1>Ugyldig fødselsnummer</h1>
		<p>Nummeret i lenken er ikke et gyldig fødselsnummer eller D-nummer.</p>
		<p><a class="knapp" href="/pasienter">Søk opp pasienten selv</a></p>
	{:else if view === 'not-found'}
		<h1>Fant ingen pasient</h1>
		<p>Ingen pasient du har tilgang til i denne virksomheten har det fødselsnummeret.</p>
		<p class="handlinger">
			<a class="knapp" href="/pasienter">Søk etter pasient</a>
			{#if form?.canRegister}<a class="knapp" href="/pasienter/ny">Registrer ny pasient</a>{/if}
		</p>
	{:else if view === 'not-unique'}
		<h1>Flere pasienter har samme nummer</h1>
		<p>Journalen fant mer enn én pasient med det fødselsnummeret, og åpner ingen av dem på gjetning.</p>
		<p><a class="knapp" href="/pasienter">Søk etter pasient</a></p>
	{:else if view === 'confirm'}
		<h1>Åpne pasientjournal?</h1>
		<p>
			Du fulgte en lenke som ber journalen åpne en pasient. Åpner du den, loggføres oppslaget
			på deg, som ellers.
		</p>
		<form method="POST" action="?/open" class="handlinger">
			<input type="hidden" name="id" value={data.id} />
			<input type="hidden" name="kilde" value={data.source ?? ''} />
			<button type="submit" class="primar">Åpne journalen</button>
			<a class="knapp" href="/">Avbryt</a>
		</form>
	{:else if nothingToOpen}
		<h1>Ingen pasient i lenken</h1>
		<p>Lenken sa ikke hvilken pasient som skulle åpnes.</p>
		<p><a class="knapp" href="/pasienter">Søk etter pasient</a></p>
	{:else}
		<h1>Åpner pasienten …</h1>
		<noscript>
			<p>
				Denne lenken trenger JavaScript for å lese hvilken pasient den gjelder.
				<a href="/pasienter">Søk opp pasienten selv</a>.
			</p>
		</noscript>
	{/if}
</section>

<!-- Filled in from the fragment and posted, so the number reaches the record
     in a request body and never in an address. -->
{#if data.state === 'fragment'}
	<form method="POST" action="?/resolve" bind:this={resolveForm} hidden>
		<input type="hidden" name="fnr" bind:this={numberField} autocomplete="off" />
		<input type="hidden" name="kilde" value={data.source ?? ''} />
	</form>
{/if}

<style>
	.apne {
		max-width: 38rem;
		margin: 2rem auto;
	}

	.apne h1 {
		font-size: 1.3rem;
		margin-top: 0;
	}

	.handlinger {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}

	.handlinger button {
		width: auto;
	}
</style>
