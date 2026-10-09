<script lang="ts">
	import { onMount } from 'svelte';
	let { data, form } = $props();

	// What the server said, with an action's answer taking over from the load's.
	const view = $derived((form?.state ?? data.state) as string);

	let resolveForm = $state<HTMLFormElement | null>(null);
	let numberField = $state<HTMLInputElement | null>(null);
	let phoneField = $state<HTMLInputElement | null>(null);
	// The fragment held nothing this page can use.
	let nothingToOpen = $state(false);
	// The link came from another site: the number is read, and waits for a click.
	let awaitingConfirm = $state(false);

	onMount(() => {
		// The fragment may hold a phone number or a national identity number.
		// Take it out of the address bar and out of this history entry before
		// anything else, whatever state the page is in - including when the user
		// is not signed in.
		const raw = location.hash;
		if (raw) history.replaceState(history.state, '', location.pathname + location.search);

		if (data.state !== 'fragment' || form) return;
		// A program may have percent-encoded the plus sign of a country code.
		let hash = raw;
		try {
			hash = decodeURIComponent(raw);
		} catch {
			// Not valid encoding: read it as it stands.
		}
		const number = /^#(?:fnr|fodselsnummer)=(\d{11})$/.exec(hash)?.[1];
		// Any spelling: the server reduces it to digits, or refuses it.
		const phone = /^#(?:tlf|telefon|phone)=(.{1,64})$/.exec(hash)?.[1];
		if (resolveForm && numberField && phoneField && (number || phone)) {
			if (number) numberField.value = number;
			else if (phone) phoneField.value = phone;
			if (data.confirm) awaitingConfirm = true;
			else resolveForm.submit();
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
		<h1>Personopplysninger hører ikke hjemme i adressen</h1>
		<p>
			Lenken hadde et telefonnummer eller fødselsnummer i spørredelen av adressen. Den delen
			blir skrevet i logger underveis, så journalen åpner ikke pasienten på den måten.
		</p>
		<p class="svak">
			Til den som har satt opp integrasjonen: legg nummeret etter <span class="mono">#</span>
			(<span class="mono">/apne/pasient#tlf=…</span> eller
			<span class="mono">/apne/pasient#fnr=…</span>), eller bruk journalens pasient-id
			(<span class="mono">/apne/pasient?id=…</span>). Det som står etter
			<span class="mono">#</span>, sendes aldri til en tjener.
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
	{:else if view === 'bad-phone'}
		<h1>Ugyldig telefonnummer</h1>
		<p>Lenken inneholdt noe som ikke er et telefonnummer. Det skjer blant annet ved skjult nummer.</p>
		<p><a class="knapp" href="/pasienter">Søk opp pasienten selv</a></p>
	{:else if view === 'no-phone-match'}
		<h1>Fant ingen pasient med det nummeret</h1>
		<p>
			Ingen pasient du har tilgang til i denne virksomheten er registrert med telefonnummeret
			det ringes fra.
		</p>
		<p class="handlinger">
			<a class="knapp" href="/pasienter">Søk etter pasient</a>
			{#if form?.canRegister}<a class="knapp" href="/pasienter/ny">Registrer ny pasient</a>{/if}
		</p>
	{:else if view === 'choose' && form?.matches}
		<h1>Flere pasienter har dette nummeret</h1>
		<p class="svak">Velg hvem det gjelder. Bare den du åpner, blir loggført som åpnet.</p>
		<ul class="treff">
			{#each form.matches as p (p.id)}
				<li>
					<span>
						<strong>{p.name}</strong>
						<span class="svak">
							{#if p.nationalIdMasked}<span class="mono">{p.nationalIdMasked}</span> ·{/if}
							{#if p.age !== null}{p.age} år ·{/if}
							{p.gender}
						</span>
					</span>
					<form method="POST" action="?/open">
						<input type="hidden" name="id" value={p.id} />
						<input type="hidden" name="via" value="telefon" />
						<input type="hidden" name="kilde" value={form.source ?? ''} />
						<button type="submit" class="liten primar">Åpne</button>
					</form>
				</li>
			{/each}
		</ul>
		<p><a class="knapp" href="/pasienter">Ingen av disse – søk etter pasient</a></p>
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
	{:else if awaitingConfirm}
		<h1>Åpne pasientjournal?</h1>
		<p>
			Du fulgte en lenke som ber journalen slå opp og åpne en pasient. Gjør du det, loggføres
			oppslaget på deg, som ellers.
		</p>
		<p class="handlinger">
			<button type="button" class="primar" onclick={() => resolveForm?.submit()}>Slå opp og åpne</button>
			<a class="knapp" href="/">Avbryt</a>
		</p>
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
		<input type="hidden" name="tlf" bind:this={phoneField} autocomplete="off" />
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

	.treff {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0;
	}

	.treff li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--kant);
	}

	.treff li > span {
		display: flex;
		flex-direction: column;
	}

	.treff form {
		margin: 0;
	}

	.treff button {
		width: auto;
	}
</style>
