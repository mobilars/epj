<script lang="ts">
	let { data } = $props();
</script>

<h1>Dokumentasjon</h1>
<p class="svak">Journalen er en SMART on FHIR-server. En app trenger ikke annet enn dette.</p>

<section class="kort">
	<h2>Endepunkter</h2>
	<table>
		<tbody>
			<tr><th>FHIR</th><td class="mono">{data.fhir}</td></tr>
			<tr><th>Oppdagelse</th><td class="mono">{data.wellKnown}</td></tr>
		</tbody>
	</table>
	<p class="svak liten">
		Alt annet – autorisasjon, token, nøkler – leser appen ut av oppdagelsesdokumentet. Ikke skriv
		adressene inn i appen; da knytter du den til denne ene installasjonen.
	</p>
</section>

<section class="kort">
	<h2>Slik starter en app</h2>
	<ol>
		<li>Journalen åpner <span class="mono">launch-URL-en</span> med <span class="mono">iss</span> og <span class="mono">launch</span>.</li>
		<li>Appen henter <span class="mono">.well-known/smart-configuration</span> fra <span class="mono">iss</span>.</li>
		<li>Appen sender brukeren til <span class="mono">authorization_endpoint</span> med PKCE (S256) og <span class="mono">aud</span> lik <span class="mono">iss</span>.</li>
		<li>Journalen spør brukeren om samtykke, med mindre virksomheten har godkjent appen på forhånd.</li>
		<li>Appen bytter koden mot et token på <span class="mono">token_endpoint</span>.</li>
		<li>Tokenet brukes som <span class="mono">Bearer</span> mot FHIR-endepunktet.</li>
	</ol>
</section>

<section class="kort">
	<h2>Det som er verdt å vite</h2>
	<ul>
		<li><strong>PKCE er påkrevd</strong>, også for konfidensielle klienter.</li>
		<li>
			<strong>En app får aldri mer enn brukeren.</strong> Scopene snevres inn mot rollen til den
			som er innlogget – be om det appen trenger, og regn med å få mindre.
		</li>
		<li>
			<strong>Alt loggføres på brukeren.</strong> Oppslag appen gjør, står i pasientens innsynslogg
			med appens navn.
		</li>
		<li>
			<strong>Legg klient-id-en på launch-URL-en</strong> med <span class="mono">{'{client_id}'}</span>.
			Da kan den samme appen brukes fra flere journaler uten å bygges på nytt.
		</li>
		<li>
			<strong>Appen kjøres i en ramme</strong> inne i journalen. Sett
			<span class="mono">frame-ancestors</span> slik at journalen får lov, og ikke
			<span class="mono">X-Frame-Options: DENY</span>.
		</li>
		<li>
			<strong>Binary og Group er ikke tilgjengelige.</strong> Ingen av dem har en pasientreferanse,
			og da kan ikke tilgangen vurderes per pasient.
		</li>
	</ul>
</section>

<section class="kort">
	<h2>Vurdering</h2>
	<p>
		En app må godkjennes før en virksomhet kan installere den. Vi ser på hva appen ber om, om
		beskrivelsen stemmer med scopene, og om adressene er de appen faktisk bruker. Blir noe avvist,
		står grunnen på appen din.
	</p>
	<p class="svak liten">
		Endrer du scopes eller adresser på en godkjent app, går den til vurdering igjen. Det som ble
		godkjent, var akkurat de scopene og de adressene.
	</p>
</section>
