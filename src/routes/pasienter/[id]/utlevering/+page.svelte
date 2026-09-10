<script lang="ts">
	import { page } from '$app/state';
	let { data } = $props();
	const patientId = $derived(page.params.id);
</script>

<div class="rad-mellom">
	<h2>Utlevering av journal</h2>
</div>

<p>
	Pasienten har rett til innsyn i og kopi av egen journal, og journalen kan overføres til en annen
	behandler. Utleveringen bygges på det du selv har tilgang til akkurat nå: har pasienten sperret
	deler av journalen, følger de ikke med. Hver utlevering registreres i sikkerhetsloggen med
	hjemmel, mottaker og omfang.
</p>

<section class="kort">
	<h3>Lag utlevering</h3>
	<form method="GET" action="/pasienter/{patientId}/utlevering/last-ned">
		<fieldset>
			<legend>Hjemmel</legend>
			{#each data.grunner as g, i (g.kode)}
				<label style="font-weight:400">
					<input type="radio" name="grunn" value={g.kode} checked={i === 0} style="width:auto" />
					{g.tekst}
					<span class="svak mono">purposeOfUse {g.purposeOfUse}</span>
				</label>
			{/each}
		</fieldset>

		<div class="rad">
			<div style="flex:1 1 18rem">
				<label for="mottaker">Utleveres til</label>
				<input id="mottaker" name="mottaker" placeholder="Navn på mottaker, eller «pasienten selv»" />
			</div>
			<div style="flex:0 0 10rem">
				<label for="fra">Fra dato</label>
				<input id="fra" name="fra" type="date" />
			</div>
			<div style="flex:0 0 10rem">
				<label for="til">Til dato</label>
				<input id="til" name="til" type="date" />
			</div>
		</div>
		<p class="svak">La datofeltene stå tomme for å utlevere hele journalen.</p>

		<fieldset>
			<legend>Format</legend>
			<label style="font-weight:400">
				<input type="radio" name="format" value="html" checked style="width:auto" />
				<strong>Lesbar utskrift (HTML)</strong>
				<span class="svak">For pasienten selv, for utskrift og for arkivering på papir.</span>
			</label>
			<label style="font-weight:400">
				<input type="radio" name="format" value="txt" style="width:auto" />
				<strong>Ren tekst</strong>
				<span class="svak">Samme innhold uten formatering.</span>
			</label>
			<label style="font-weight:400">
				<input type="radio" name="format" value="json" style="width:auto" />
				<strong>FHIR-dokument (JSON)</strong>
				<span class="svak">Bundle av typen «document» med en Composition først. For overføring til et annet journalsystem.</span>
			</label>
		</fieldset>

		<button type="submit" class="primar">Lag og last ned</button>
	</form>
</section>

<div class="kort tabell-omslag">
	<h3>Tidligere utleveringer</h3>
	{#if data.tidligere.length === 0}
		<p class="svak">Ingen utleveringer er registrert på denne pasienten.</p>
	{:else}
		<table>
			<thead>
				<tr><th>Tidspunkt</th><th>Utlevert av</th><th>Hjemmel</th><th>Referanse</th></tr>
			</thead>
			<tbody>
				{#each data.tidligere as u (u.seq)}
					<tr>
						<td>{u.tidspunkt}</td>
						<td>{u.hvem}</td>
						<td>{u.grunn} <span class="svak mono">{u.purposeOfUse}</span></td>
						<td class="mono">{u.referanse}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
