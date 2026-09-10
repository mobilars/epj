<script lang="ts">
	let { data } = $props();
	const m = $derived(data.message);
</script>

<h1>{m.type}</h1>
<div class="kort">
	<dl class="rutenett">
		<div><dt class="svak">Retning</dt><dd>{m.direction === 'ut' ? 'Sendt' : 'Mottatt'}</dd></div>
		<div><dt class="svak">Tidspunkt</dt><dd>{m.created_at}</dd></div>
		<div><dt class="svak">Motpart</dt><dd>{m.sender}</dd></div>
		<div><dt class="svak">Pasient</dt><dd>{m.patientName || '–'}</dd></div>
		<div><dt class="svak">Status</dt><dd>{m.status}{#if m.apprec} (AppRec {m.apprec}){/if}</dd></div>
		<div><dt class="svak">MsgId</dt><dd class="mono">{m.msgId}</dd></div>
	</dl>
	{#if m.detalj}<div class="varsel varsel-advarsel">{m.detalj}</div>{/if}
	<div class="rad">
		{#if m.patientId}<a class="knapp" href="/pasienter/{m.patientId}">Åpne journal</a>{/if}
		{#if m.fhirRef}<span class="merke merke-info mono">{m.fhirRef}</span>{/if}
	</div>
</div>

<details class="kort">
	<summary>Meldingen slik den ble utvekslet (XML etter KITH-standarden)</summary>
	<p class="svak">
		Helsemeldinger over Norsk helsenett utveksles som XML i hodemeldingsformatet.
		Innholdet er speilet som FHIR-ressurs i journalen, og er tilgjengelig som JSON via /fhir.
	</p>
	<pre class="mono" style="overflow-x:auto; white-space:pre-wrap">{m.xml}</pre>
</details>
