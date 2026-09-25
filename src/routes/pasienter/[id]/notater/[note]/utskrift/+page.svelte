<script lang="ts">
	import { onMount } from 'svelte';
	let { data } = $props();

	let scripted = $state(false);
	onMount(() => (scripted = true));
</script>

<svelte:head>
	<title>Journalnotat · {data.patient?.name ?? ''}</title>
</svelte:head>

<!-- On screen: what this is and how to print it. Not printed. -->
<div class="kun-skjerm utskriftslinje">
	<a class="knapp" href="/pasienter/{data.patientId}/notater">Tilbake til notatene</a>
	{#if scripted}
		<button type="button" class="primar" onclick={() => window.print()}>Skriv ut</button>
	{:else}
		<span class="svak">Skriv ut med Ctrl+P (⌘P på Mac).</span>
	{/if}
	<span class="svak">Utskriften loggføres i pasientens innsynslogg.</span>
</div>

<article class="utskrift kort">
	<header class="utskrift-hode">
		<div>
			<div class="utskrift-virksomhet">{data.organisation}</div>
			<h1>{data.note.title}</h1>
		</div>
		<div class="utskrift-pasient">
			<strong>{data.patient?.name}</strong><br />
			{#if data.patient?.nationalId}Fødselsnummer: <span class="mono">{data.patient.nationalId}</span><br />{/if}
			{#if data.patient?.birthDate}Født: {data.patient.birthDate}{/if}
		</div>
	</header>

	{#if data.note.status === 'entered-in-error'}
		<p class="utskrift-feilfort" role="note">
			FEILFØRT – dette notatet er merket som feilført og skal ikke brukes som grunnlag for behandling.
		</p>
	{/if}

	<dl class="utskrift-meta">
		<dt>Dato</dt>
		<dd>{data.note.date}</dd>
		<dt>Skrevet av</dt>
		<dd>{data.note.author || '–'}</dd>
		<dt>Versjon</dt>
		<dd>{data.note.version}</dd>
	</dl>

	{#each data.note.sections as s (s.title)}
		<section class="utskrift-seksjon">
			<h2>{s.title}</h2>
			<p>{s.text}</p>
		</section>
	{/each}

	{#if data.note.corrections.length}
		<section class="utskrift-seksjon">
			<h2>Merknader</h2>
			<ul>
				{#each data.note.corrections as c, i (i)}
					<li>{c.text}{#if c.time} <span class="svak">({c.time})</span>{/if}</li>
				{/each}
			</ul>
		</section>
	{/if}

	<footer class="utskrift-fot">
		Utskrift fra pasientjournal. Skrevet ut {data.printedAt} av {data.printedBy}.
		Inneholder taushetsbelagte opplysninger.
	</footer>
</article>

<style>
	.utskriftslinje {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.75rem;
	}

	.utskriftslinje button {
		width: auto;
	}

	.utskrift {
		max-width: 48rem;
	}

	.utskrift-hode {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		border-bottom: 2px solid var(--tekst);
		padding-bottom: 0.6rem;
		margin-bottom: 0.8rem;
	}

	.utskrift-virksomhet {
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--tekst-svak);
	}

	.utskrift-hode h1 {
		margin: 0.15rem 0 0;
		font-size: 1.35rem;
	}

	.utskrift-pasient {
		text-align: right;
		font-size: 0.9rem;
		line-height: 1.45;
	}

	.utskrift-feilfort {
		border: 2px solid var(--fare);
		color: var(--fare);
		font-weight: 700;
		padding: 0.5rem 0.75rem;
	}

	.utskrift-meta {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.15rem 1rem;
		font-size: 0.9rem;
		margin: 0 0 1rem;
	}

	.utskrift-meta dt {
		color: var(--tekst-svak);
	}

	.utskrift-meta dd {
		margin: 0;
	}

	.utskrift-seksjon h2 {
		font-size: 1rem;
		margin: 1rem 0 0.25rem;
	}

	.utskrift-seksjon p {
		white-space: pre-line;
		margin: 0;
	}

	.utskrift-fot {
		margin-top: 1.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--kant);
		font-size: 0.78rem;
		color: var(--tekst-svak);
	}

	@media (max-width: 40rem) {
		.utskrift-pasient {
			text-align: left;
		}
	}
</style>
