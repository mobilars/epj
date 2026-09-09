<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: PasientLayoutData; children: Snippet } = $props();

	type PasientLayoutData = {
		patientId: string;
		pasient: { navn: string; fodselsnummerMaskert: string | null; alder: number | null; kjonn: string; telefon: string | null; dod: boolean } | null;
		nektet: string | null;
		minimaltNavn: string | null;
		nodrett: boolean;
		sperret: boolean;
		kanBeOmNodrett: boolean;
		krevErEngangskode: boolean;
	};

	// Feil fra nødrettshandlingen kommer tilbake som spørringsparameter, siden
	// handlingen ligger på en egen rute og ikke kan levere `form` til layouten.
	const nodrettFeil = $derived(page.url.searchParams.get('nodrettFeil'));

	const faner = $derived([
		{ href: `/pasienter/${data.patientId}`, tekst: 'Oversikt' },
		{ href: `/pasienter/${data.patientId}/notater`, tekst: 'Journalnotater' },
		{ href: `/pasienter/${data.patientId}/legemidler`, tekst: 'Legemidler' },
		{ href: `/pasienter/${data.patientId}/meldinger`, tekst: 'Meldinger' },
		{ href: `/pasienter/${data.patientId}/oppgjor`, tekst: 'Oppgjør' },
		{ href: `/pasienter/${data.patientId}/logg`, tekst: 'Innsynslogg' }
	]);
</script>

{#if data.pasient}
	<div class="pasientbanner" class:nodrett={data.nodrett}>
		<strong>{data.pasient.navn}</strong>
		<span class="mono">{data.pasient.fodselsnummerMaskert ?? ''}</span>
		<span>{data.pasient.alder} år · {data.pasient.kjonn}</span>
		{#if data.pasient.telefon}<span class="svak">{data.pasient.telefon}</span>{/if}
		{#if data.pasient.dod}<span class="merke merke-fare">Død</span>{/if}
		{#if data.sperret}<span class="merke merke-advarsel">Sperret journal</span>{/if}
		{#if data.nodrett}
			<span class="merke merke-fare">Nødrettstilgang aktiv</span>
			<form method="POST" action="/pasienter/{data.patientId}/nodrett?/avsluttNodrett">
				<button type="submit" class="liten">Avslutt nå</button>
			</form>
		{/if}
	</div>

	{#if data.nodrett}
		<div class="varsel varsel-feil" role="alert">
			Du ser denne journalen med nødrettstilgang. Oppslaget er logget særskilt, blir gjennomgått
			av ledelsen, og pasienten har rett til å få vite om det.
		</div>
	{/if}

	<nav class="faner" aria-label="Journalfaner">
		{#each faner as f (f.href)}
			<a href={f.href} aria-current={page.url.pathname === f.href ? 'page' : undefined}>{f.tekst}</a>
		{/each}
	</nav>

	{@render children()}
{:else}
	<h1>Ingen tilgang til journalen</h1>
	<div class="varsel varsel-advarsel" role="alert">{data.nektet}</div>

	<div class="kort">
		<h2>{data.minimaltNavn ?? `Pasient ${data.patientId}`}</h2>
		<p>
			Du har ikke dokumentert behandlingsrelasjon til denne pasienten
			{#if data.sperret}, eller pasienten har sperret journalen{/if}.
		</p>

		{#if data.kanBeOmNodrett}
			<h3>Be om nødrettstilgang</h3>
			<p class="svak">
				Nødrettstilgang skal bare brukes når det er nødvendig for å gi forsvarlig helsehjelp og
				det ikke er mulig å innhente samtykke. Tilgangen varer i fire timer, logges særskilt, og
				gjennomgås av ledelsen.
			</p>

			{#if nodrettFeil}
				<div class="varsel varsel-feil" role="alert">{nodrettFeil}</div>
			{/if}

			<form method="POST" action="/pasienter/{data.patientId}/nodrett?/nodrett">
				<div class="felt">
					<label for="begrunnelse">Begrunnelse</label>
					<textarea
						id="begrunnelse"
						name="begrunnelse"
						required
						minlength="15"
						placeholder="Beskriv den konkrete situasjonen som gjør oppslaget nødvendig."
					></textarea>
				</div>
				{#if data.krevErEngangskode}
					<div class="felt">
						<label for="engangskode">Bekreft med engangskode</label>
						<input id="engangskode" name="engangskode" inputmode="numeric" autocomplete="one-time-code" required />
					</div>
				{/if}
				<button type="submit" class="fare">Åpne journalen på nødrett</button>
			</form>
		{:else}
			<p>Rollen din kan ikke bruke nødrettstilgang. Kontakt behandlingsansvarlig lege.</p>
		{/if}
	</div>
{/if}
