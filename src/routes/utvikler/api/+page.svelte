<script lang="ts">
	let { data } = $props();
</script>

<h1>API-referanse</h1>
<p class="svak">
	Alt en app kan gjøre mot journalen, med adressene til denne installasjonen. Det som ikke står her,
	finnes ikke — og det som står her, svarer koden for, ikke dokumentasjonen.
</p>

<section class="kort">
	<h2>Adresser</h2>
	<table>
		<tbody>
			<tr><th>FHIR (R5)</th><td class="mono">{data.fhir}</td></tr>
			<tr><th>SMART-oppdagelse</th><td class="mono">{data.wellKnown}</td></tr>
			<tr><th>Nøkler (JWKS)</th><td class="mono">{data.jwks}</td></tr>
			<tr><th>CDS Hooks-oppdagelse</th><td class="mono">{data.cds}</td></tr>
		</tbody>
	</table>
	<p class="svak liten">
		<span class="mono">aud</span> i autorisasjonsforespørselen er FHIR-adressen — den samme som
		<span class="mono">iss</span> ved oppstart fra journalen. Nettstedet alene er utstederen, ikke
		FHIR-endepunktet. Journalen godtar utstederen som alias og noterer avviket i loggen.
	</p>
</section>

<section class="kort">
	<h2>Token-svaret</h2>
	<p>Ut over det SMART App Launch beskriver, får appen dette i svaret fra <span class="mono">token_endpoint</span>:</p>
	<table>
		<thead><tr><th>Felt</th><th>Hvor</th><th>Hva</th></tr></thead>
		<tbody>
			<tr><td class="mono">patient</td><td>svar</td><td>Pasienten appen ble startet på</td></tr>
			<tr><td class="mono">encounter</td><td>svar</td><td>Kontakten, når journalen har én i kontekst</td></tr>
			<tr><td class="mono">fhirUser</td><td>svar, id_token</td><td>Behandleren, som <span class="mono">Practitioner/…</span></td></tr>
			<tr><td class="mono">practitioner</td><td>svar</td><td>Samme behandler, bare id-en — navnet WebMed-apper leser</td></tr>
			<tr><td class="mono">tenant</td><td>svar, access token, id_token</td><td>Virksomheten, journalens egen id</td></tr>
			<tr><td class="mono">smart_app_officeApiUrl</td><td>access token</td><td>Samme virksomhet, under navnet WebMed-apper leser</td></tr>
			<tr><td class="mono">smart_app_practitioner</td><td>access token</td><td>Samme behandler, under navnet WebMed-apper leser</td></tr>
			<tr><td class="mono">organizationNumber</td><td>id_token</td><td>Virksomhetens organisasjonsnummer — navnet PasientSky-apper leser</td></tr>
			<tr><td class="mono">need_patient_banner</td><td>svar</td><td><span class="mono">false</span> når journalen viser pasienten selv</td></tr>
			<tr><td class="mono">smart_style_url</td><td>svar</td><td>Farger og skrift, så appen kan ligne journalen</td></tr>
		</tbody>
	</table>
	<p class="svak liten">
		Behandlerens identitet oppgis uten at appen ber om <span class="mono">fhirUser</span>-scopet.
		Det er et bevisst avvik fra SMART — se
		<span class="mono">docs/apne-punkter.md</span> — fordi en app som ikke finner referansen ellers
		skriver en <span class="mono">DocumentReference</span> med en forfatter som ikke finnes.
	</p>
</section>

<section class="kort">
	<h2>Scope</h2>
	<p>
		SMART v2 (<span class="mono">patient/Observation.rs</span>) og v1
		(<span class="mono">patient/Observation.read</span>) forstås begge. Appen får aldri mer enn brukeren:
		det som bes om, snevres inn mot appens registrering <em>og</em> mot rollen til den som er
		innlogget. Be om det appen trenger, og regn med å få mindre — les <span class="mono">scope</span>
		i token-svaret.
	</p>
	<ul>
		<li><span class="mono">patient/</span> gjelder pasienten i kontekst; <span class="mono">user/</span> alt brukeren har tilgang til.</li>
		<li>Å utvide en apps scope-liste trekker tilbake alle brukeres samtykke, og hver blir spurt på nytt.</li>
		<li><span class="mono">Binary</span> kan ikke søkes i, uansett scope. Se vedlegg nedenfor.</li>
	</ul>
</section>

<section class="kort">
	<h2>FHIR-endepunktet</h2>
	<p>
		Journalen er <strong>R5</strong>. Lesing, opprettelse, oppdatering, sletting, søk, historikk,
		<span class="mono">$everything</span> på pasient, og <span class="mono">$validate</span>. Hvert
		kall vurderes mot scope, rolle, behandlingsrelasjon og sperring, og loggføres på den appen kaller
		på vegne av.
	</p>
	<h3>Ressurstyper som støttes ({data.types.length})</h3>
	<p class="mono liten">{data.types.join(' · ')}</p>
	<h3>R4 på vei inn</h3>
	<p>
		En R4-formet <span class="mono">DocumentReference</span> godtas ved skriving og lagres som R5:
		<span class="mono">context.encounter</span>, <span class="mono">context.period</span>,
		<span class="mono">authenticator</span>, <span class="mono">content.format</span> og
		<span class="mono">relatesTo.code</span> oversettes. Svar kommer alltid i R5.
	</p>
	<h3>Vedlegg (Binary)</h3>
	<p>
		<span class="mono">POST /fhir/Binary</span> og <span class="mono">GET /fhir/Binary/&lbrace;id&rbrace;</span>.
		Et vedlegg knyttes til pasienten i launch-konteksten når det skrives — eller til
		<span class="mono">Binary.securityContext</span> hvis appen setter den — og leses bare av dem som
		får se den pasienten. Post vedlegget først, så en <span class="mono">DocumentReference</span> som
		peker på det. Vedlegg i en <span class="mono">Bundle</span> avvises; søk i Binary avvises.
	</p>
</section>

<section class="kort">
	<h2>Terminologi</h2>
	<p>
		ICPC-2, norsk utgave fra Helsedirektoratet ({data.icpc2.count} koder, utgave
		{data.icpc2.version}), svares fra journalen selv. Systemet er
		<span class="mono">{data.icpc2.url}</span>. En diagnose journalen skal ta imot, må ha en kode som
		finnes der.
	</p>
	<table>
		<tbody>
			<tr>
				<th class="mono">GET /fhir/CodeSystem/$lookup</th>
				<td><span class="mono">?system=&lt;icpc-2&gt;&amp;code=K86</span> → navn, engelsk betegnelse, kapittel, ICD-10-referanse, inklusjon og eksklusjon</td>
			</tr>
			<tr>
				<th class="mono">GET /fhir/CodeSystem/$validate-code</th>
				<td><span class="mono">?system=&lt;icpc-2&gt;&amp;code=K</span> → <span class="mono">result=false</span> for et kapittel, med grunn</td>
			</tr>
			<tr>
				<th class="mono">GET /fhir/ValueSet/$expand</th>
				<td><span class="mono">?url=&lt;icpc-2&gt;?fhir_vs&amp;filter=hypertensjon&amp;count=10</span> → treff, best først. <span class="mono">system=</span> godtas også.</td>
			</tr>
			<tr>
				<th class="mono">GET /fhir/CodeSystem?url=</th>
				<td>Kodeverket selv, med egenskapene det svarer med</td>
			</tr>
		</tbody>
	</table>
	<p class="svak liten">
		SNOMED CT (norsk utgave) svares ikke her ennå; Helsedirektoratets terminologiserver gjør det.
	</p>
</section>

<section class="kort">
	<h2>CDS Hooks</h2>
	<p>
		Journalen fyrer <span class="mono">patient-view</span>, <span class="mono">medication-prescribe</span>
		og <span class="mono">order-sign</span>, og tilbyr fire tjenester selv på
		<span class="mono">{data.cds}</span>. Hvert kall bærer et JWT signert med journalens nøkkel —
		verifiser mot JWKS-adressen over.
	</p>
	<ul>
		<li>Et kort sier noe. Det skriver ikke, stopper ikke, endrer ikke.</li>
		<li>Et forslag (<span class="mono">suggestions</span>) kan bare <em>opprette</em> ressurser om pasienten kortet gjaldt. Trykket er behandlerens skriving, med behandlerens tilganger.</li>
		<li>Sett <span class="mono">uuid</span> på kortene: tilbakemelding (<span class="mono">/feedback</span>, 2.0) peker på dem.</li>
		<li>Journalen sender ikke pasientdata i forespørselen. Vil tjenesten vite mer, henter den selv med Backend Services — og det loggføres.</li>
		<li>Svar innen tre sekunder. Journalen venter ikke lenger.</li>
	</ul>
	<p class="svak liten">Hele beskrivelsen: <span class="mono">docs/cds-hooks.md</span> i kildekoden.</p>
</section>

<section class="kort">
	<h2>Tjeneste-til-tjeneste</h2>
	<p>
		SMART Backend Services: <span class="mono">client_credentials</span> med
		<span class="mono">private_key_jwt</span> (ES256). Registrer nøklene (JWKS eller
		<span class="mono">jwks_uri</span>) på appen. Scope er <span class="mono">system/…</span>, og
		vurderes mot det virksomheten har gitt appen, ikke mot noen bruker.
	</p>
</section>

<section class="kort">
	<h2>Feil</h2>
	<p>
		Alt fra <span class="mono">/fhir</span> svarer med <span class="mono">OperationOutcome</span> og
		riktig statuskode: 401 uten gyldig token, 403 når tilgangen er vurdert og nektet, 404 for det som
		ikke finnes eller ikke støttes, 422 for det som ikke validerer. Avslag loggføres også — en app som
		prøver seg, synes i innsynsloggen.
	</p>
</section>
