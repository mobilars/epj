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
		canSkrive: boolean;
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
		{ href: `/pasienter/${data.patientId}/logg`, text: 'Innsynslogg' },
		...(data.canUtlevere ? [{ href: `/pasienter/${data.patientId}/utlevering`, text: 'Utlevering' }] : [])
	]);

	// The apps come from the root layout, and start straight from the tab bar
	// with this patient in context - the Apper tab was a page you had to open
	// before you could press start.
	const apps = $derived((page.data.apps ?? []) as { clientId: string; name: string }[]);
	let appsOpen = $state(false);
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

		<div class="nedtrekk">
			<button
				type="button"
				class="fanelenke"
				aria-expanded={appsOpen}
				onclick={() => (appsOpen = !appsOpen)}
			>
				Apper ▾
			</button>
			{#if appsOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="nedtrekk-panel" onmouseleave={() => (appsOpen = false)}>
					{#each apps as app (app.clientId)}
						<a href="/pasienter/{data.patientId}/apper/{app.clientId}">{app.name}</a>
					{:else}
						<span class="svak" style="padding: 0.4rem 0.55rem">Ingen apper er registrert.</span>
					{/each}
					<a href="/pasienter/{data.patientId}/apper">Alle apper og tilganger …</a>
				</div>
			{/if}
		</div>
	</nav>

	<div class="journalflate">
		<div class="journalinnhold">
			{@render children()}
		</div>

		<!--
			The panel follows the record on every tab. Writing the note is what a
			consultation actually consists of, and having to leave the page you are
			reading in order to write it is the wrong way round. The form posts to
			the notes action, which is the same one the Journalnotater tab uses -
			there is no second way into the record.
		-->
		<aside class="hurtigpanel" aria-label="Hurtighandlinger">
			{#if data.canSkrive}
				<section class="kort">
					<h2>Nytt notat</h2>
					<form method="POST" action="/pasienter/{data.patientId}/notater?/newValue">
						<div class="felt">
							<label for="hurtig-subjektivt">Subjektivt</label>
							<textarea id="hurtig-subjektivt" name="subjektivt" rows="3"></textarea>
						</div>
						<div class="felt">
							<label for="hurtig-objektivt">Objektivt</label>
							<textarea id="hurtig-objektivt" name="objektivt" rows="3"></textarea>
						</div>
						<div class="felt">
							<label for="hurtig-vurdering">Vurdering og plan</label>
							<textarea id="hurtig-vurdering" name="vurdering" rows="3"></textarea>
						</div>
						<button type="submit" class="primar">Lagre notat</button>
					</form>
				</section>
			{/if}

			<section class="kort">
				<h2>Snarveier</h2>
				<ul class="snarveier">
					<li><a href="/pasienter/{data.patientId}/notater">Alle journalnotater</a></li>
					<li><a href="/pasienter/{data.patientId}/legemidler">Legemidler og resepter</a></li>
					<li><a href="/pasienter/{data.patientId}/meldinger">Send melding eller henvisning</a></li>
					<li><a href="/pasienter/{data.patientId}/oppgjor">Regningskort</a></li>
					<li><a href="/pasienter/{data.patientId}/apper">Apper</a></li>
				</ul>
			</section>
		</aside>
	</div>
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
