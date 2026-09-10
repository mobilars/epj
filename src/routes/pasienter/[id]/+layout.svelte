<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: PatientLayoutData; children: Snippet } = $props();

	type PatientLayoutData = {
		patientId: string;
		patient: { name: string; nationalIdMasked: string | null; age: number | null; gender: string; phone: string | null; dod: boolean } | null;
		nektet: string | null;
		minimaltName: string | null;
		emergencyAccess: boolean;
		blocked: boolean;
		canBeAboutEmergencyAccess: boolean;
		canUtlevere: boolean;
		requireIsOneTimeCode: boolean;
	};

	// Errors from the emergency-access action come back as a query parameter,
	// since the action lives on its own route and cannot deliver `form` to the layout.
	const emergencyAccessError = $derived(page.url.searchParams.get('nodrettFeil'));

	const faner = $derived([
		{ href: `/pasienter/${data.patientId}`, text: 'Oversikt' },
		{ href: `/pasienter/${data.patientId}/notater`, text: 'Journalnotater' },
		{ href: `/pasienter/${data.patientId}/legemidler`, text: 'Legemidler' },
		{ href: `/pasienter/${data.patientId}/meldinger`, text: 'Meldinger' },
		{ href: `/pasienter/${data.patientId}/oppgjor`, text: 'Oppgjør' },
		{ href: `/pasienter/${data.patientId}/apper`, text: 'Apper' },
		{ href: `/pasienter/${data.patientId}/logg`, text: 'Innsynslogg' },
		...(data.canUtlevere ? [{ href: `/pasienter/${data.patientId}/utlevering`, text: 'Utlevering' }] : [])
	]);
</script>

{#if data.patient}
	<div class="pasientbanner" class:nodrett={data.emergencyAccess}>
		<strong>{data.patient.name}</strong>
		<span class="mono">{data.patient.nationalIdMasked ?? ''}</span>
		<span>{data.patient.age} år · {data.patient.gender}</span>
		{#if data.patient.phone}<span class="svak">{data.patient.phone}</span>{/if}
		{#if data.patient.dod}<span class="merke merke-fare">Død</span>{/if}
		{#if data.blocked}<span class="merke merke-advarsel">Sperret journal</span>{/if}
		{#if data.emergencyAccess}
			<span class="merke merke-fare">Nødrettstilgang aktiv</span>
			<form method="POST" action="/pasienter/{data.patientId}/nodrett?/avsluttNodrett">
				<button type="submit" class="liten">Avslutt nå</button>
			</form>
		{/if}
	</div>

	{#if data.emergencyAccess}
		<div class="varsel varsel-feil" role="alert">
			Du ser denne journalen med nødrettstilgang. Oppslaget er logget særskilt, blir gjennomgått
			av ledelsen, og pasienten har rett til å få vite om det.
		</div>
	{/if}

	<nav class="faner" aria-label="Journalfaner">
		{#each faner as f (f.href)}
			<a href={f.href} aria-current={page.url.pathname === f.href ? 'page' : undefined}>{f.text}</a>
		{/each}
	</nav>

	{@render children()}
{:else}
	<h1>Ingen tilgang til journalen</h1>
	<div class="varsel varsel-advarsel" role="alert">{data.nektet}</div>

	<div class="kort">
		<h2>{data.minimaltName ?? `Pasient ${data.patientId}`}</h2>
		<p>
			Du har ikke dokumentert behandlingsrelasjon til denne pasienten
			{#if data.blocked}, eller pasienten har sperret journalen{/if}.
		</p>

		{#if data.canBeAboutEmergencyAccess}
			<h3>Be om nødrettstilgang</h3>
			<p class="svak">
				Nødrettstilgang skal bare brukes når det er nødvendig for å gi forsvarlig helsehjelp og
				det ikke er mulig å innhente samtykke. Tilgangen varer i fire timer, logges særskilt, og
				gjennomgås av ledelsen.
			</p>

			{#if emergencyAccessError}
				<div class="varsel varsel-feil" role="alert">{emergencyAccessError}</div>
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
				{#if data.requireIsOneTimeCode}
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
