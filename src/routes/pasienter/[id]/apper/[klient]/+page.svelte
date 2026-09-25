<script lang="ts">
	import AppSignIn from '$lib/components/AppSignIn.svelte';
	let { data } = $props();
</script>

<!-- One thin line. The app is what the user came here for, and every pixel
     spent saying whose app it is is a pixel taken away from it. -->
<div class="applinje">
	<h1>{data.app.name}</h1>
	<span
		class="applinje-merknad"
		title="Appen kjører hos leverandøren sin og autoriserer seg selv mot journalen. Den ser bare det rollen din tillater, og oppslagene den gjør loggføres på deg."
	>Ekstern app · oppslag loggføres på deg</span>
	<span class="applinje-handlinger">
		<a
			class="knapp liten"
			href="/pasienter/{data.patientId}/apper/{data.app.clientId}/start"
			target="_blank"
			rel="noopener">Eget vindu ↗</a
		>
		<a class="knapp liten" href="/pasienter/{data.patientId}/apper">Alle apper</a>
	</span>
</div>

{#if data.mode === 'window'}
	<section class="kort">
		<h3>Appen åpnes i sitt eget vindu</h3>
		<p class="svak">
			Denne appen trenger sine egne informasjonskapsler, og nettleseren gir den dem bare når den
			er sitt eget vindu og ikke en ramme inne i journalen. Pasienten følger med over; journalen
			blir stående her.
		</p>
		<p>
			<a
				class="knapp-primar"
				href="/pasienter/{data.patientId}/apper/{data.app.clientId}/start"
				target="_blank"
				rel="noopener">Åpne {data.app.name}</a
			>
		</p>
	</section>
{:else if data.mode === 'signin'}
	<AppSignIn name={data.app.name} startUrl={data.startUrl} frameUrl={data.frameUrl} />
{:else if data.launchUrl}
	<iframe class="appramme" src={data.launchUrl} title={data.app.name} allow="clipboard-write"></iframe>
{/if}

<style>
	.applinje {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem 0.75rem;
		margin-bottom: 0.4rem;
	}

	.applinje h1 {
		font-size: 1.05rem;
		margin: 0;
	}

	.applinje-merknad {
		font-size: 0.78rem;
		color: var(--tekst-svak);
		cursor: help;
	}

	.applinje-handlinger {
		margin-left: auto;
		display: flex;
		gap: 0.4rem;
	}

	.appramme {
		width: 100%;
		height: min(86vh, 1100px);
		border: 1px solid var(--kant);
		border-radius: 8px;
		background: var(--flate);
	}
</style>
