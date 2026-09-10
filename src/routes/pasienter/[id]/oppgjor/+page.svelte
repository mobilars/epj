<script lang="ts">
	let { data, form } = $props();
	let valgte = $state<string[]>([]);

	const grupper = $derived([...new Set(data.tariffs.map((t) => t.group))]);
	const select = (code: string, on: boolean) => {
		valgte = on ? [...valgte, code] : valgte.filter((k) => k !== code);
	};
</script>

<h2>Oppgjør</h2>

{#if data.copayment}
	<div class="varsel" class:varsel-ok={data.copayment.hasExemptionCard} class:varsel-info={!data.copayment.hasExemptionCard}>
		{#if data.copayment.hasExemptionCard}
			Pasienten har <strong>frikort</strong>{#if data.copayment.validTo} til {data.copayment.validTo}{/if}.
			Egenandel skal ikke kreves inn.
		{:else}
			Opptjent egenandel i år: <strong>{data.copayment.earned}</strong> ·
			gjenstår til frikort: <strong>{data.copayment.remaining}</strong>
		{/if}
		<span class="svak">(kilde: {data.copayment.source})</span>
	</div>
{/if}

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}
{#if form?.ok}
	<div class="varsel varsel-ok" role="status">
		Regningskortet er registrert og klart for oppgjør.
		{#if form.warnings?.length}<ul>{#each form.warnings as a}<li>{a}</li>{/each}</ul>{/if}
	</div>
{/if}

{#if data.canRegistrere}
	<form method="POST" action="?/newValue" class="kort">
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

		{#each grupper as group (group)}
			<fieldset>
				<legend>{group}</legend>
				{#each data.tariffs.filter((t) => t.group === group) as t (t.code)}
					<div class="rad" style="gap:.5rem">
						<label style="flex:1 1 22rem; font-weight:400">
							<input type="checkbox" name="takst" value={t.code} style="width:auto" onchange={(e) => select(t.code, e.currentTarget.checked)} />
							<span class="mono">{t.code}</span> {t.text}
							<span class="svak">({t.reimbursement} refusjon / {t.copayment} egenandel)</span>
						</label>
						{#if t.repeterbar && valgte.includes(t.code)}
							<input name="antall_{t.code}" type="number" min="1" max="6" value="1" style="width:5rem" aria-label="Antall {t.code}" />
						{/if}
					</div>
				{/each}
			</fieldset>
		{/each}

		<p class="svak">
			Takstbeløpene er et arbeidsgrunnlag med gyldighet fra {data.validFrom} og må kontrolleres
			mot gjeldende normaltariff før produksjonsbruk.
		</p>
		<button type="submit" class="primar">Registrer regningskort</button>
	</form>
{/if}

<div class="kort tabell-omslag">
	<h3>Registrerte regningskort</h3>
	{#if data.card.length === 0}
		<p class="svak">Ingen regningskort for denne pasienten.</p>
	{:else}
		<table>
			<thead><tr><th>Dato</th><th>Takster</th><th>Diagnose</th><th class="hoyre">Refusjon</th><th class="hoyre">Egenandel</th><th>Status</th></tr></thead>
			<tbody>
				{#each data.card as k (k.id)}
					<tr>
						<td>{k.date}</td>
						<td class="mono">{k.lines.join(', ')}</td>
						<td class="mono">{k.diagnosis}</td>
						<td class="hoyre tall">{k.reimbursement}</td>
						<td class="hoyre tall">{k.copayment}{#if k.exemption}<br /><span class="svak">{k.exemption}</span>{/if}</td>
						<td>
							<span class="merke" class:merke-ok={k.status === 'godkjent'} class:merke-fare={k.status === 'avvist'}>{k.status}</span>
							{#if k.rejection}<br /><span class="svak">{k.rejection}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
