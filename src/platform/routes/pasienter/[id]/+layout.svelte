<script lang="ts">
	import Nedtrekk from '$lib/components/Nedtrekk.svelte';
	import ExternalFrame from '$lib/components/ExternalFrame.svelte';
	import { externalAppLabel } from '$lib/external-app';
	import { appManifests } from '$apps/registry';
	import { patientSidePanel as SidePanel } from '$apps/slots';

	// Measured, so the side panel can stick just below the header whatever the
	// header's height turns out to be on this screen.
	let headerHeight = $state(0);
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { data, children }: { data: PatientLayoutData; children: Snippet } = $props();

	type PanelApp = { name: string; clientId: string; url: string | null; openInNewTab: boolean };

	type PatientLayoutData = {
		patientId: string;
		patient: { name: string; nationalIdMasked: string | null; nationalIdUnverified?: boolean; age: number | null; gender: string; phone: string | null; dod: boolean } | null;
		nektet: string | null;
		minimaltName: string | null;
		emergencyAccess: boolean;
		blocked: boolean;
		canBeAboutEmergencyAccess: boolean;
		canRegisterAsCarer: boolean;
		canUtlevere: boolean;
		canSkrive: boolean;
		canRestrict: boolean;
		canEditDetails?: boolean;
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
			app: Boolean(app),
			appName: app?.name,
			approved: !app || page.data.apps?.find((a: { clientId: string }) => a.clientId === app.clientId)?.approved !== false
		};
	};

	/**
	 * The tabs of the consultation itself.
	 *
	 * What a clinician opens many times a day, and what the tab bar is for.
	 */

	const appTabs = appManifests
		.flatMap((app) => (app.patientTab ? [app.patientTab] : []))
		.sort((a, b) => a.order - b.order);
	const patientLinks = appManifests
		.flatMap((app) => (app.patientLink ? [app.patientLink] : []))
		.sort((a, b) => a.order - b.order);

	const faner = $derived(appTabs.map((tab) => fane(tab.segment, tab.label)));

	/**
	 * The pages about the record rather than in it.
	 *
	 * Reading who has looked at the journal, handing it out, and restricting it
	 * are things one does occasionally and deliberately. Kept off the bar so the
	 * tabs of the consultation stay on one line and stay quick to hit, and put
	 * last so the apps - which are used during the consultation - come first.
	 */
	const merFaner = $derived([
		...(data.canEditDetails ? [fane('rediger', 'Pasientopplysninger')] : []),
		fane('logg', 'Innsynslogg'),
		...(data.canUtlevere ? [fane('utlevering', 'Utlevering')] : []),
		...(data.canRestrict ? [fane('sperring', 'Sperring')] : [])
	]);

	const paMerSide = $derived(merFaner.some((f) => page.url.pathname === f.href));

	// Managing a restriction is not reading the record, so that page is shown
	// even when the record itself is denied - otherwise a restriction against
	// everyone would be one nobody could lift.
	const onRestrictionPage = $derived(page.url.pathname.endsWith('/sperring'));

	// The apps come from the root layout, and start straight from the tab bar
	// with this patient in context - the Apper tab was a page you had to open
	// before you could press start. An app the practice has given a tab of its
	// own sits beside the record's tabs; the rest wait under the dropdown.
	const apps = $derived((page.data.apps ?? []) as { clientId: string; name: string; approved: boolean; inPatientTabs?: boolean; openInNewTab?: boolean }[]);
	/**
	 * Where a link to an app should go.
	 *
	 * An app that wants its own window is opened straight from the press, through
	 * the start endpoint that mints a launch for it. Sending it to the app page
	 * first meant a page whose only content was a button to press next, and the
	 * setting looked broken because nothing opened.
	 */
	const appLenke = (app: { clientId: string; openInNewTab?: boolean }) =>
		app.openInNewTab
			? `/pasienter/${data.patientId}/apper/${app.clientId}/start`
			: `/pasienter/${data.patientId}/apper/${app.clientId}`;

	const tabAppsOwn = $derived(apps.filter((a) => a.inPatientTabs));
	const dropdownApps = $derived(apps.filter((a) => !a.inPatientTabs));
</script>

{#if data.patient}
	<!-- Banner and tabs stick together as one block. The banner alone was
	     sticky, and the tab bar - with a higher z-index for its dropdowns -
	     scrolled straight over it, one text on top of the other. -->
	<div class="journalhode" bind:clientHeight={headerHeight}>
	<div class="pasientbanner" class:nodrett={data.emergencyAccess}>
		<strong>{data.patient.name}</strong>
		<span class="mono">{data.patient.nationalIdMasked ?? ''}</span>
		{#if data.patient.nationalIdUnverified}
			<span class="merke merke-advarsel" title="Kontrollsifrene stemmer ikke. Nummeret brukes ikke mot Helfo, reseptformidleren eller i meldinger.">Ikke gyldig fødselsnummer</span>
		{/if}
		<span>{#if data.patient.age !== null}{data.patient.age} år · {/if}{data.patient.gender}</span>
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
			<a
				href={f.href}
				class:ekstern-lenke={f.app}
				title={f.appName ? externalAppLabel(f.appName, f.approved) : undefined}
				aria-current={page.url.pathname === f.href ? 'page' : undefined}
			>{#if !f.approved}⚠ {/if}{f.text}</a>
		{/each}
		{#each tabAppsOwn as app (app.clientId)}
			{@const href = appLenke(app)}
			<a
				{href}
				class="ekstern-lenke"
				title={externalAppLabel(app.name, app.approved)}
				target={app.openInNewTab ? '_blank' : undefined}
				rel={app.openInNewTab ? 'noopener' : undefined}
				aria-current={page.url.pathname === href ? 'page' : undefined}
			>{#if !app.approved}⚠ {/if}{app.name}{#if app.openInNewTab} ↗{/if}</a>
		{/each}

		<Nedtrekk etikett="Apper ▾">
			{#snippet children()}
					{#each dropdownApps as app (app.clientId)}
						<a
							href={appLenke(app)}
							class="ekstern-lenke"
							title={externalAppLabel(app.name, app.approved)}
							target={app.openInNewTab ? '_blank' : undefined}
							rel={app.openInNewTab ? 'noopener' : undefined}
						>{#if !app.approved}⚠ {/if}{app.name}{#if app.openInNewTab} ↗{/if}</a>
					{:else}
						<span class="svak" style="padding: 0.4rem 0.55rem">
							{apps.length ? 'Alle apper har egen fane.' : 'Ingen apper er registrert.'}
						</span>
					{/each}
				<a href="/pasienter/{data.patientId}/apper">Alle apper og tilganger …</a>
			{/snippet}
		</Nedtrekk>
		{#if merFaner.length}
			<Nedtrekk etikett="Mer ▾" aktiv={paMerSide}>
				{#snippet children()}
					{#each merFaner as f (f.text)}
						<a href={f.href} aria-current={page.url.pathname === f.href ? 'page' : undefined}>{#if !f.approved}⚠ {/if}{f.text}</a>
					{/each}
				{/snippet}
			</Nedtrekk>
		{/if}
	</nav>

	</div>

	<div class="journalflate" style="--journalhode: {headerHeight}px">
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
					{#if data.widePanel.openInNewTab}
						<p class="svak">
							Appen trenger sine egne informasjonskapsler og må være sitt eget vindu.
						</p>
						<a class="knapp-primar" href="/pasienter/{data.patientId}/apper/{data.widePanel.clientId}/start" target="_blank" rel="noopener">
							Åpne {data.widePanel.name}
						</a>
					{:else if data.widePanel.url}
						<ExternalFrame class="appramme appramme-hoved" src={data.widePanel.url} title={data.widePanel.name} clientId={data.widePanel.clientId} />
					{/if}
				</section>
			{/if}
			{@render children()}
		</div>

		<!--
			The panel follows the record on every tab. What is in it comes from an
			app: an external one if the practice or the user chose one, otherwise
			what the built-in apps offer.
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
					{#if data.sidePanel.openInNewTab}
						<p class="svak">
							Appen trenger sine egne informasjonskapsler og må være sitt eget vindu.
						</p>
						<a class="knapp-primar" href="/pasienter/{data.patientId}/apper/{data.sidePanel.clientId}/start" target="_blank" rel="noopener">
							Åpne {data.sidePanel.name}
						</a>
					{:else if data.sidePanel.url}
						<ExternalFrame class="appramme appramme-side" src={data.sidePanel.url} title={data.sidePanel.name} clientId={data.sidePanel.clientId} />
					{/if}
				</section>
			{:else if data.canSkrive && SidePanel}
				<SidePanel patientId={data.patientId} />
			{/if}

			<section class="kort">
				<div class="rad-mellom">
					<h2>Snarveier</h2>
					<a class="svak" href="/innstillinger">Panel</a>
				</div>
				<ul class="snarveier">
					{#each patientLinks as link (link.segment)}
						<li><a href={fane(link.segment, link.label).href}>{link.label}</a></li>
					{/each}
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

		{#if data.canRegisterAsCarer}
			<h3>Er du behandler av pasienten?</h3>
			<p class="svak">Registrerer du deg, får du tilgang til journalen. Det krever ingen godkjenning, men loggføres på deg.</p>
			<form method="POST" action="/pasienter?/registrerBehandler">
				<input type="hidden" name="patientId" value={data.patientId} />
				<button type="submit" class="primar">Registrer som behandler av denne pasienten</button>
			</form>
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
