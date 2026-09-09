<script lang="ts">
	let { data, form } = $props();
	let valgte = $state<string[]>([]);

	const grupper = $derived([...new Set(data.takster.map((t) => t.gruppe))]);
	const velg = (kode: string, på: boolean) => {
		valgte = på ? [...valgte, kode] : valgte.filter((k) => k !== kode);
	};
</script>

<h2>Oppgjør</h2>

{#if data.egenandel}
	<div class="varsel" class:varsel-ok={data.egenandel.harFrikort} class:varsel-info={!data.egenandel.harFrikort}>
		{#if data.egenandel.harFrikort}
			Pasienten har <strong>frikort</strong>{#if data.egenandel.gyldigTil} til {data.egenandel.gyldigTil}{/if}.
			Egenandel skal ikke kreves inn.
		{:else}
			Opptjent egenandel i år: <strong>{data.egenandel.opptjent}</strong> ·
			gjenstår til frikort: <strong>{data.egenandel.gjenstaende}</strong>
		{/if}
		<span class="svak">(kilde: {data.egenandel.kilde})</span>
	</div>
{/if}

{#if form?.feil}<div class="varsel varsel-feil" role="alert">{form.feil}</div>{/if}
{#if form?.ok}
	<div class="varsel varsel-ok" role="status">
		Regningskortet er registrert og klart for oppgjør.
		{#if form.advarsler?.length}<ul>{#each form.advarsler as a}<li>{a}</li>{/each}</ul>{/if}
	</div>
{/if}

{#if data.kanRegistrere}
	<form method="POST" action="?/nytt" class="kort">
		<h3>Nytt regningskort</h3>
		<div class="rad">
			<div style="flex: 0 0 11rem"><label for="dato">Dato</label><input id="dato" name="dato" type="date" value={new Date().toISOString().slice(0, 10)} /></div>
			<div style="flex: 0 0 12rem">
				<label for="kontakttype">Kontakttype</label>
				<select id="kontakttype" name="kontakttype">
					<option value="kontor">Kontorkonsultasjon</option>
					<option value="e-konsultasjon">E-konsultasjon</option>
					<option value="sykebesok">Sykebesøk</option>
					<option value="telefon">Telefon</option>
					<option value="enkel">Enkel kontakt</option>
				</select>
			</div>
			<div style="flex: 0 0 9rem"><label for="diagnoseKode">Diagnose (ICPC-2)</label><input id="diagnoseKode" name="diagnoseKode" placeholder="K86" /></div>
			<div style="flex: 0 0 8rem"><label for="hpr">HPR-nummer</label><input id="hpr" name="hpr" /></div>
		</div>
		<label><input type="checkbox" name="spesialist" value="på" style="width:auto" /> Spesialist i allmennmedisin</label>

		{#each grupper as gruppe (gruppe)}
			<fieldset>
				<legend>{gruppe}</legend>
				{#each data.takster.filter((t) => t.gruppe === gruppe) as t (t.kode)}
					<div class="rad" style="gap:.5rem">
						<label style="flex:1 1 22rem; font-weight:400">
							<input type="checkbox" name="takst" value={t.kode} style="width:auto" onchange={(e) => velg(t.kode, e.currentTarget.checked)} />
							<span class="mono">{t.kode}</span> {t.tekst}
							<span class="svak">({t.refusjon} refusjon / {t.egenandel} egenandel)</span>
						</label>
						{#if t.repeterbar && valgte.includes(t.kode)}
							<input name="antall_{t.kode}" type="number" min="1" max="6" value="1" style="width:5rem" aria-label="Antall {t.kode}" />
						{/if}
					</div>
				{/each}
			</fieldset>
		{/each}

		<p class="svak">
			Takstbeløpene er et arbeidsgrunnlag med gyldighet fra {data.gyldigFra} og må kontrolleres
			mot gjeldende normaltariff før produksjonsbruk.
		</p>
		<button type="submit" class="primar">Registrer regningskort</button>
	</form>
{/if}

<div class="kort tabell-omslag">
	<h3>Registrerte regningskort</h3>
	{#if data.kort.length === 0}
		<p class="svak">Ingen regningskort for denne pasienten.</p>
	{:else}
		<table>
			<thead><tr><th>Dato</th><th>Takster</th><th>Diagnose</th><th class="hoyre">Refusjon</th><th class="hoyre">Egenandel</th><th>Status</th></tr></thead>
			<tbody>
				{#each data.kort as k (k.id)}
					<tr>
						<td>{k.dato}</td>
						<td class="mono">{k.linjer.join(', ')}</td>
						<td class="mono">{k.diagnose}</td>
						<td class="hoyre tall">{k.refusjon}</td>
						<td class="hoyre tall">{k.egenandel}{#if k.fritak}<br /><span class="svak">{k.fritak}</span>{/if}</td>
						<td>
							<span class="merke" class:merke-ok={k.status === 'godkjent'} class:merke-fare={k.status === 'avvist'}>{k.status}</span>
							{#if k.avvisning}<br /><span class="svak">{k.avvisning}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
