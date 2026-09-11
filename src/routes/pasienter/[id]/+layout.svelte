<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: PatientLayoutData; children: Snippet } = $props();

	type PanelApp = { name: string; clientId: string; url: string };

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
		canRestrict: boolean;
		tabApps: Record<string, { name: string; clientId: string }>;
		sidePanel: PanelApp | null;
		widePanel: PanelApp | null;
		requireIsOneTimeCode: boolean;
	};

	// Errors from the emergency-access action come back as a query parameter,
	// since the action lives on its own route and cannot deliver `form` to the layout.
	const emergencyAccessError = $derived(page.url.searchParams.get('nodrettFeil'));

	/**
	 * A tab points at the app that has taken it over, if one has.
	 *
	 * The record keeps its own page for every tab no app answers for, so
	 * removing an app leaves a working record rather than a hole.
	 */
	const fane = (segment: string, text: string) => {
		const app = data.tabApps?.[segment];
		return {
			href: app
				? `/pasienter/${data.patientId}/apper/${app.clientId}`
				: `/pasienter/${data.patientId}${segment ? `/${segment}` : ''}`,
			text,
			app: Boolean(app)
		};
	};

	const faner = $derived([
		fane('', 'Oversikt'),
		fane('notater', 'Journalnotater'),
		fane('legemidler', 'Legemidler'),
		fane('meldinger', 'Meldinger'),
		fane('oppgjor', 'Oppgjør'),
		fane('logg', 'Innsynslogg'),
		...(data.canUtlevere ? [fane('utlevering', 'Utlevering')] : []),
		...(data.canRestrict ? [fane('sperring', 'Sperring')] : [])
	]);

	// Managing a restriction is not reading the record, so that page is shown
	// even when the record itself is denied - otherwise a restriction against
	// everyone would be one nobody could lift.
	const onRestrictionPage = $derived(page.url.pathname.endsWith('/sperring'));

	// The apps come from the root layout, and start straight from the tab bar
	// with this patient in context - the Apper tab was a page you had to open
	// before you could press start. An app the practice has given a tab of its
	// own sits beside the record's tabs; the rest wait under the dropdown.
	const apps = $derived((page.data.apps ?? []) as { clientId: string; name: string; inPatientTabs?: boolean }[]);
	const tabAppsOwn = $derived(apps.filter((a) => a.inPatientTabs));
	const dropdownApps = $derived(apps.filter((a) => !a.inPatientTabs));
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
			<form method="POST" action="/pasienter/{data.patientId}/nodrett?/endEmergencyAccess">
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
		{#each faner as f (f.text)}
			<a href={f.href} aria-current={page.url.pathname === f.href ? 'page' : undefined}>{f.text}</a>
		{/each}
		{#each tabAppsOwn as app (app.clientId)}
			{@const href = `/pasienter/${data.patientId}/apper/${app.clientId}`}
			<a {href} aria-current={page.url.pathname === href ? 'page' : undefined}>{app.name}</a>
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
					{#each dropdownApps as app (app.clientId)}
						<a href="/pasienter/{data.patientId}/apper/{app.clientId}">{app.name}</a>
					{:else}
						<span class="svak" style="padding: 0.4rem 0.55rem">
							{apps.length ? 'Alle apper har egen fane.' : 'Ingen apper er registrert.'}
						</span>
					{/each}
					<a href="/pasienter/{data.patientId}/apper">Alle apper og tilganger …</a>
				</div>
			{/if}
		</div>
	</nav>

	<div class="journalflate">
		<div class="journalinnhold">
			{#if data.widePanel}
				<!-- An app holding the wide place sits above the record's own content
				     rather than replacing it: the tabs still work, and the app is
				     part of the surface instead of a detour away from it. -->
				<section class="kort apppanel">
					<div class="rad-mellom">
						<h2>{data.widePanel.name}</h2>
						<a class="svak" href="/pasienter/{data.patientId}/apper/{data.widePanel.clientId}">Åpne stor</a>
					</div>
					<iframe class="appramme appramme-hoved" src={data.widePanel.url} title={data.widePanel.name}></iframe>
				</section>
			{/if}
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
			{#if data.sidePanel}
				<!-- The panel is an app. The record's own note editor is only the
				     default; a practice can put something else here, and a user can
				     choose for themselves. -->
				<section class="kort apppanel">
					<div class="rad-mellom">
						<h2>{data.sidePanel.name}</h2>
						<a class="svak" href="/innstillinger">Bytt</a>
					</div>
					<iframe class="appramme appramme-side" src={data.sidePanel.url} title={data.sidePanel.name}></iframe>
				</section>
			{:else if data.canSkrive}
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
				<div class="rad-mellom">
					<h2>Snarveier</h2>
					<a class="svak" href="/innstillinger">Panel</a>
				</div>
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
{:else if onRestrictionPage}
	<div class="pasientbanner">
		<strong>{data.minimaltName ?? `Pasient ${data.patientId}`}</strong>
		{#if data.blocked}<span class="merke merke-advarsel">Sperret journal</span>{/if}
		<a class="svak" href="/pasienter/{data.patientId}">Tilbake til journalen</a>
	</div>
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
		{#if data.blocked && data.canRestrict && !onRestrictionPage}
			<p><a href="/pasienter/{data.patientId}/sperring">Se og forvalt sperringene på journalen</a></p>
		{/if}

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

			<form method="POST" action="/pasienter/{data.patientId}/nodrett?/emergencyAccess">
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
