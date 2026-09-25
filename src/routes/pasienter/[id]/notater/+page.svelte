<script lang="ts">
	import { onMount } from 'svelte';
	import Icpc2Picker from '$lib/components/Icpc2Picker.svelte';
	let { data, form } = $props();

	type Draft = {
		tittel: string;
		subjektivt: string;
		objektivt: string;
		vurdering: string;
		diagnoseKode: string;
		malnavn: string;
	};
	type Part = { text: string; hit: boolean };

	const blank: Draft = {
		tittel: 'Konsultasjonsnotat',
		subjektivt: '',
		objektivt: '',
		vurdering: '',
		diagnoseKode: '',
		malnavn: ''
	};

	// A template applied in the browser, without a round trip. Null until one is.
	let applied = $state<Draft | null>(null);

	// What the form starts from, strongest first: a draft the server handed back
	// after refusing it, a template picked here, a template picked without
	// scripting (?mal=), and otherwise an empty note. The form is rebuilt when
	// this changes and left alone otherwise, so typing is never overwritten.
	const source = $derived<Draft>(
		form?.draft
			? { ...blank, ...form.draft }
			: (applied ??
					(data.prefill
						? {
								...blank,
								tittel: data.prefill.tittel || blank.tittel,
								subjektivt: data.prefill.subjektivt,
								objektivt: data.prefill.objektivt,
								vurdering: data.prefill.vurdering,
								malnavn: data.templates.find((t) => t.id === data.prefill?.templateId)?.name ?? ''
							}
						: blank))
	);

	let noteForm = $state<HTMLFormElement | null>(null);
	let scripted = $state(false);
	onMount(() => (scripted = true));

	const field = (name: string) =>
		(noteForm?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';

	function applyTemplate(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const template = data.templates.find((t) => t.id === select.value);
		if (!template) return;
		const typed = ['subjektivt', 'objektivt', 'vurdering'].some((n) => field(n).trim());
		if (typed && !confirm(`Erstatte det du har skrevet med malen «${template.name}»?`)) {
			select.value = '';
			return;
		}
		applied = {
			tittel: template.title || blank.tittel,
			subjektivt: template.subjective,
			objektivt: template.objective,
			vurdering: template.assessment,
			// The diagnosis belongs to this consultation, not to the template.
			diagnoseKode: field('diagnoseKode'),
			malnavn: template.name
		};
	}
</script>

{#snippet marked(parts: Part[])}{#each parts as part, i (i)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{/snippet}

<div class="rad-mellom">
	<h2>Journalnotater</h2>
</div>

<form method="GET" class="notatsok" role="search">
	<input
		type="search"
		name="q"
		value={data.search?.query ?? ''}
		placeholder="Søk i notatene – ord, diagnose, forfatter …"
		aria-label="Søk i journalnotatene"
		autocomplete="off"
		data-shortcut-search
	/>
	<button type="submit">Søk</button>
	{#if data.search}
		<a class="knapp" href="/pasienter/{data.patientId}/notater">Vis alle</a>
	{/if}
</form>

{#if data.search}
	<p class="svak" role="status">
		{#if data.search.hits === 0}
			Ingen notater inneholder «{data.search.query}».
		{:else}
			{data.search.hits} {data.search.hits === 1 ? 'notat' : 'notater'} inneholder «{data.search.query}».
		{/if}
		Søkt i {data.search.read} {data.search.read === 1 ? 'notat' : 'notater'}.
		{#if data.search.truncated}
			Søket stoppet etter de {data.search.limit} nyeste; eldre notater er ikke med.
		{/if}
	</p>
{/if}

{#if form?.error}
	<div class="varsel varsel-feil" role="alert">{form.error}</div>
{/if}
{#if form?.savedTemplate}
	<div class="varsel varsel-ok" role="status">Lagret som mal: «{form.savedTemplate}».</div>
{/if}

<!-- Hidden rather than removed while searching, so a note someone had started
     is still there when they come back from the results. -->
{#if data.canSkrive}
	<section class="kort" hidden={Boolean(data.search)}>
		<div class="rad-mellom">
			<h3>Nytt notat</h3>
			{#if data.templates.length}
				<form method="GET" class="malvalg">
					<label for="mal">Mal</label>
					<select id="mal" name="mal" onchange={applyTemplate}>
						<option value="">Velg mal …</option>
						{#each data.templates as t (t.id)}
							<option value={t.id} selected={data.prefill?.templateId === t.id}>{t.name}</option>
						{/each}
					</select>
					{#if !scripted}<button type="submit" class="liten">Bruk mal</button>{/if}
				</form>
			{/if}
		</div>

		{#key source}
			<form method="POST" action="?/newValue" bind:this={noteForm}>
				<div class="felt">
					<label for="tittel">Tittel</label>
					<input id="tittel" name="tittel" value={source.tittel} />
				</div>
				<div class="felt">
					<label for="subjektivt">Subjektivt</label>
					<textarea id="subjektivt" name="subjektivt" placeholder="Hva pasienten forteller" value={source.subjektivt}></textarea>
				</div>
				<div class="felt">
					<label for="objektivt">Objektivt</label>
					<textarea id="objektivt" name="objektivt" placeholder="Funn ved undersøkelse" value={source.objektivt}></textarea>
				</div>
				<div class="felt">
					<label for="vurdering">Vurdering og plan</label>
					<textarea id="vurdering" name="vurdering" placeholder="Vurdering, tiltak og videre oppfølging" value={source.vurdering}></textarea>
				</div>
				<fieldset>
					<legend>Kontaktdiagnose (ICPC-2)</legend>
					<Icpc2Picker name="diagnoseKode" value={source.diagnoseKode} />
				</fieldset>
				<div class="knapperad">
					<button type="submit" class="primar">Lagre notat</button>
				</div>

				<!-- Saved from the same form, so a template is written the same way a
				     note is. Saving under a name that exists replaces that template,
				     which is how one is edited. -->
				<details class="lagre-mal">
					<summary>Lagre teksten som mal</summary>
					<p class="svak">
						Tittel og de tre tekstfeltene lagres som en mal bare du ser. Diagnosen lagres ikke.
						Bruker du et navn du har fra før, blir den malen erstattet.
					</p>
					<div class="felt">
						<label for="malnavn">Navn på malen</label>
						<input id="malnavn" name="malnavn" maxlength="80" value={source.malnavn} placeholder="For eksempel: Årskontroll diabetes" />
					</div>
					<button type="submit" class="liten" formaction="?/saveTemplate">Lagre som mal</button>
				</details>
			</form>
		{/key}

		{#if data.templates.length}
			<details class="mine-maler">
				<summary>Mine maler ({data.templates.length})</summary>
				<ul>
					{#each data.templates as t (t.id)}
						<li>
							<span>{t.name}</span>
							<form method="POST" action="?/deleteTemplate">
								<input type="hidden" name="id" value={t.id} />
								<button type="submit" class="liten diskret">Slett</button>
							</form>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</section>
{/if}

{#if data.notes.length === 0}
	{#if !data.search}<p class="svak">Ingen journalnotater registrert.</p>{/if}
{:else}
	{#each data.notes as n (n.id)}
		<article class="kort">
			<div class="rad-mellom">
				<h3>{@render marked(n.titleParts)}</h3>
				<span class="notathandlinger">
					{#if n.status === 'entered-in-error'}<span class="merke merke-fare">Feilført</span>{/if}
					<span class="merke">versjon {n.version}</span>
					<a class="knapp liten" href="/pasienter/{data.patientId}/notater/{n.id}/utskrift">Skriv ut</a>
				</span>
			</div>
			<p class="svak">{n.date} · {n.forfatter}</p>
			{#each n.seksjoner as s (s.title)}
				<h4>{s.title}</h4>
				<p class="notattekst">{@render marked(s.parts)}</p>
			{/each}
			{#if n.status !== 'entered-in-error'}
				<details>
					<summary>Merk som feilført</summary>
					<form method="POST" action="?/feilfor">
						<input type="hidden" name="id" value={n.id} />
						<div class="felt">
							<label for="begrunnelse-{n.id}">Begrunnelse</label>
							<input id="begrunnelse-{n.id}" name="begrunnelse" required minlength="5" />
							<small>Notatet blir stående, men merkes som feilført. Begrunnelsen lagres sammen med det.</small>
						</div>
						<button type="submit" class="fare liten">Merk som feilført</button>
					</form>
				</details>
			{/if}
		</article>
	{/each}
	{#if data.recentOnly}
		<p class="svak">Viser de nyeste notatene. Bruk søket for å finne eldre.</p>
	{/if}
{/if}

<style>
	.notatsok {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.notatsok input {
		flex: 1;
	}

	.notatsok button,
	.notatsok .knapp {
		width: auto;
		flex: none;
	}

	.malvalg {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.malvalg label {
		margin: 0;
		font-size: 0.85rem;
	}

	.malvalg select {
		width: auto;
		min-width: 12rem;
	}

	.lagre-mal,
	.mine-maler {
		margin-top: 0.75rem;
	}

	.mine-maler ul {
		list-style: none;
		padding: 0;
		margin: 0.4rem 0 0;
	}

	.mine-maler li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.2rem 0;
		border-bottom: 1px solid var(--kant);
	}

	.mine-maler li form {
		margin: 0;
	}

	.notathandlinger {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	/* Notes are written with line breaks, and they carry meaning: a list of
	   findings, a plan in steps. */
	.notattekst {
		white-space: pre-line;
	}

	mark {
		background: var(--advarsel-svak);
		color: inherit;
		outline: 1px solid var(--advarsel);
		border-radius: 2px;
		padding: 0 1px;
	}

	@media (max-width: 40rem) {
		.notatsok {
			flex-wrap: wrap;
		}
	}
</style>
