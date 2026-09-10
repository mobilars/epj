# Veikart og oppgaveliste

Det som ikke er bygget ennå, og hva det vil kreve. Listen er ment å være ærlig:
den skiller mellom det som må på plass før systemet kan brukes på ekte
pasientopplysninger, og det som gjør det til et bedre journalsystem.

Ting som må *avklares eller verifiseres mot en kilde* står i
[apne-punkter.md](apne-punkter.md). Denne listen er om arbeid som skal *gjøres*.

Merking:

- **[K]** Kritisk før klinisk bruk. Uten dette skal systemet ikke ta imot ekte
  pasientopplysninger.
- **[V]** Viktig. Systemet virker uten, men noen må gjøre jobben manuelt.
- **[N]** Neste. Klar forbedring når grunnmuren står.

---

## 1. Før klinisk bruk

### 1.1 Vedtaksflyt for retting og sletting **[K]**

`slettEndelig()` finnes i koden, men er bevisst ikke eksponert. Sletting etter
helsepersonelloven § 43 forutsetter et dokumentert vedtak, ikke en knapp.

Å bygge: registrering av begjæring, saksbehandling med frist, vedtak med
begrunnelse, klageadgang til Statsforvalteren, og gjennomføring av selve
slettingen av den som har myndighet. Retting etter § 42 hører til samme flyt, og
skal alltid være en tilføyelse - den opprinnelige teksten skal fortsatt kunne
leses.

Berører: `src/lib/server/journal/`, ny tabell for begjæringer, `admin`-flate.

### 1.2 Jobbplanlegging **[K]**

Funksjonene finnes, men ingenting kaller dem periodisk: `sendKo()` (utgående
meldinger), `ventendeKvitteringer()`, `ryddRateLimit()`,
`fjernUtdaterteNokler()`, `verifiserLoggkjede()`.

Uten dette blir meldinger liggende i kø til noen åpner en side som sender dem.

Å bygge: en planlegger som tåler flere instanser. Alle jobbene er trygge å kjøre
parallelt, og `sendKo()` bruker allerede rådgivende lås i PostgreSQL. Enkleste
vei er en CronJob per jobb i Kubernetes som kaller et internt endepunkt, eller
en `setInterval` i én utpekt instans.

### 1.3 Gjennomgang av nødrettsoppslag i grensesnittet **[K]**

`ugjennomgattNodrett()` lister oppslagene, og `/admin` viser antallet. Men det
finnes ingen flate der ledelsen kan *kvittere ut* en gjennomgang med en
vurdering, og ingen påminnelse når noe har ligget for lenge.

Normen krever at nødrettsoppslag gjennomgås. En teller som ingen kan lukke, blir
et tall folk slutter å se på.

### 1.4 Oppbevaringstid og sletting av logg **[K]**

`config.audit.retentionYears` er definert, men ingen jobb sletter gamle innslag.

Det vanskelige er hash-kjeden: en sletting som bryter kjeden må skje slik at
resten fortsatt kan verifiseres. Foreslått løsning er å arkivere det som slettes
med sin egen kjede-signatur, og la et «segmentskille» i kjeden peke på arkivet.

### 1.5 Varsling ved avvik **[V]**

Systemet oppdager brudd i loggkjeden, ugjennomgått nødrett og manglende
kvitteringer, men sier ikke fra til noen. Det bør gå et varsel - e-post eller
integrasjon mot virksomhetens overvåking - når noe av dette inntreffer.

### 1.6 Ytelsestesting **[V]**

Systemet er ikke lastet. To steder vil trenge oppmerksomhet først:
`Patient/$everything` med mange ressurser, og søk som avgrenses på mange
pasienter samtidig. Journalutleveringen henter opptil 1000 ressurser og bygger
et dokument i minnet.

Å gjøre: et lasttestoppsett med realistiske datamengder (2000 pasienter, ti års
journal), og måling før og etter.

---

## 2. Klinisk funksjonalitet

### 2.1 Timebok **[V]**

`Appointment`, `Schedule` og `Slot` er støttet på API-et, og dagens timer vises
på arbeidsflaten. Det som mangler er selve timeboken: kalendervisning per
behandler, ledige tider, booking, flytting og avbestilling, gjentakende timer og
ventelister.

Dette er trolig den enkeltfunksjonen et fastlegekontor vil savne mest.

### 2.2 Kontrasignering **[V]**

Rollen `turnuslege` er definert som en rolle hvis notater kan kreve
kontrasignering, men flyten er ikke bygget: markering av notater som venter,
kø hos veileder, signering med begrunnelse, og sporing i journalen.

### 2.3 Prøvesvarhåndtering **[V]**

Innkommende laboratoriesvar tas imot som meldinger, men det finnes ingen
arbeidsflate for å kvittere ut svar, markere som sett, eller varsle om
patologiske verdier som ikke er lest. Uleste patologiske prøvesvar er en kjent
pasientsikkerhetsrisiko.

### 2.4 Strukturert legemiddelgjennomgang **[N]**

Legemiddellisten hentes fra SFM, men det finnes ingen flate for systematisk
gjennomgang: seponering med begrunnelse, samstemming mot pasientens egen liste,
og dokumentasjon av gjennomgangen som et eget journalnotat.

### 2.5 Sykmelding og legeerklæringer **[N]**

Ingen støtte for sykmelding (NAV), legeerklæring ved arbeidsuførhet, eller de
øvrige NAV-skjemaene. Dette krever integrasjon mot NAVs tjenester og er et
prosjekt i seg selv.

### 2.6 Svangerskapsjournal og helsestasjon **[N]**

Rollen `jordmor` finnes, men det er ingen strukturert svangerskapsjournal.

### 2.7 Interaksjonsvarsler fra en vedlikeholdt kilde **[N]**

SFM-simulatoren har fire kjente interaksjoner, nok til å vise flyten. I
`live`-modus kommer varslene fra SFM. Skal journalen gi egne varsler i tillegg,
trengs en klinisk vedlikeholdt kilde (FEST, Interaksjonsdatabasen).

---

## 3. Innbygger og samhandling

### 3.1 Innbyggerflate **[V]**

Rollen `pasient` har `patient/`-scope mot egen journal og innsyn i egen logg,
men det er ikke bygget noe grensesnitt for innbyggere. Journalutleveringen
dekker innsynsretten i dag, men bare ved at noen på kontoret gjør den.

Alternativet, som trolig er riktigere: la innbyggere komme via Helsenorge, og
bygge de API-ene Helsenorge trenger i stedet for en egen flate.

### 3.2 Digital dialog med pasient **[N]**

E-konsultasjon, timebestilling og reseptfornyelse fra pasient. Krever
innbyggerpålogging (ID-porten via HelseID) og en gjennomtenkt flyt for hvem som
svarer og innen hvilken frist.

### 3.3 Kjernejournal og pasientens legemiddelliste **[N]**

Oppslag i Kjernejournal og skriving til Pasientens legemiddelliste er ikke
implementert. Begge krever avtale og godkjenning fra Norsk helsenett.

### 3.4 Flere meldingstyper **[N]**

Bygget: dialogmelding, henvisning, epikrise, applikasjonskvittering. Ikke
bygget: rekvisisjon og svarrapport for lab og radiologi (utover mottak),
pleie- og omsorgsmeldinger (PLO), fødselsepikrise, og melding om
legemiddelutlevering.

---

## 4. Plattform og drift

### 4.1 Avvikling av virksomhet **[V]**

`/systemadmin` kan suspendere en virksomhet, men «avviklet» gjør i dag det
samme som suspendert. En reell avvikling må håndtere at journalene skal
oppbevares i mange år etter at legekontoret er lagt ned: eksport av alt
innholdet, overføring til den som overtar journalansvaret, og til slutt en
kontrollert sletting med vedtak bak seg.

Partisjonen i HAPI slettes ikke i dag, og det er med vilje.

### 4.2 Flytting av virksomhet mellom installasjoner **[N]**

Et legekontor som bytter leverandør skal kunne ta journalene med seg.
Journalutleveringen dekker én pasient om gangen; det som mangler er en
virksomhetsomfattende eksport og en tilsvarende import.

### 4.3 Nøkkelrotasjon som rutine **[V]**

`roterNokkel()` finnes, og gamle nøkler beholdes i JWKS til tokens er utløpt.
Men rotasjonen skjer ikke av seg selv, og det finnes ingen flate som viser
nøkkelens alder. Rotasjon av `EPJ_DATA_KEY` (omkryptering av alt innhold) er
ikke implementert i det hele tatt.

### 4.4 Utlevering av sikkerhetslogg til eksternt arkiv **[K]**

Loggen er hash-lenket og append-only i databasen, men en som får kontroll over
databasen kan fortsatt fjerne triggeren. Kjeden gjør at det *oppdages*, ikke at
det *forhindres*.

Å bygge: fortløpende utsending av loggen til et skrivebeskyttet arkiv utenfor
installasjonen, med kjede-signatur som kan sammenlignes.

### 4.5 Måling og overvåking **[V]**

Ingen målepunkter (metrics). Et journalsystem i drift bør minst eksponere
svartider, feilrater, køstørrelse for meldinger og antall aktive sesjoner - per
virksomhet.

### 4.6 Styrt database **[V]** - delvis gjort

`deploy/kubernetes/03-postgres.yaml` er fortsatt én instans uten replikering.
[`deploy/apus/`](../deploy/apus) viser hvordan den byttes ut med CloudNativePG,
og det oppsettet kjører. Det som gjenstår er det som gjør en styrt database
verdt navnet:

- `backup` mot objektlager, slik at WAL-arkiveringen faktisk tar vare på noe.
  Uten det er punkt-i-tid-gjenoppretting bare en mulighet, ikke en rutine.
- Mer enn én instans. `instances: 1` gir omstart, ikke failover.
- Testet gjenoppretting. En sikkerhetskopi ingen har gjenopprettet fra er en
  antakelse.

### 4.7b HAPI-partisjonering lar seg ikke slå på **[K]**

Journalen kjører nå med `EPJ_HAPI_MULTITENANT=false` i
[deploy/apus](../deploy/apus), altså mot HAPI sin rot i stedet for
`/fhir/<virksomhet>/`.

Grunnen er at partisjoneringen ikke lar seg slå på i `hapiproject/hapi:v8.0.0`.
Konfigurasjonen monteres nå som fil (se 04-hapi.yaml), og det virker for
dialekten - men `tenant_identification_strategy: URL_BASED` slår ikke inn, og
`/fhir/<virksomhet>/metadata` svarer fortsatt 404 «Unknown resource type».
Loggen viser i tillegg at Hibernate ender på `org.hibernate.dialect.PostgreSQLDialect`
selv om HAPI sin egen dialektklasse lastes.

Det er forsvarlig i denne installasjonen fordi den har én virksomhet. Det er
**ikke** forsvarlig med flere: uten partisjonering ligger alle virksomheters
kliniske data i samme rom i HAPI, og skillet hviler utelukkende på at
`tenant_id` filtreres riktig i vår egen kode. `tests/multitenancy.test.ts`
kjører mot en partisjonsbevisst testdobbel, ikke mot HAPI selv, og fanger derfor
ikke dette.

Må løses før systemet tar imot mer enn én virksomhet. Se også 6.5 og 6.6.

### 4.8 Vedlegg (Binary) med pasienttilknytning **[V]**

`Binary` ble tatt ut av de støttede ressurstypene i sikkerhetsgjennomgangen:
typen har ingen `subject`, så tilgangskontrollen kunne ikke avgjøre hvilken
pasient et vedlegg hørte til, og verken tjenstlig behov eller sperring lot seg
håndheve. Se [sikkerhet.md](sikkerhet.md).

Journalen har dermed ingen vei til skannede dokumenter, PDF-er og bilder. Skal
den få det, må pasienten utledes fra den `DocumentReference` som peker på
ressursen, og tilgangen vurderes mot den - ikke mot vedlegget selv. Det samme
gjelder `Group`, som ble tatt ut av samme grunn.

### 4.9 Gjenbruk av engangskoder **[N]**

En TOTP-kode kan brukes om igjen innenfor sitt eget vindu, om lag 90 sekunder
med den klokkeslakken vi godtar. Å hindre det krever at brukte koder lagres per
bruker til vinduet er ute. Verdt å gjøre hvis engangskoder blir hovedveien inn;
med HelseID som hovedvei er det mindre viktig.

### 4.10 Tellingen i søkeresultater røper sperrede pasienter **[N]**

`sokRessurser()` filtrerer bort sperrede pasienter etter at HAPI har svart, og
trekker fra det som ble fjernet på siden. `total` kommer likevel fra HAPI, og
kan dermed antyde at det finnes treff brukeren ikke får se. Å rette det krever
enten at sperringen håndheves i selve spørringen, eller at `total` sløyfes når
noe er filtrert bort.

### 4.7 Rader per virksomhet i databasen (RLS) **[N]**

Isolasjonen hviler i dag på at all kode filtrerer på `tenant_id`, og på at
`krevTenant()` kaster når konteksten mangler. Det er testet
(`tests/multitenancy.test.ts`), men det er fortsatt disiplin.

Row Level Security i PostgreSQL ville flyttet garantien til databasen. Det ble
valgt bort fordi det krever å holde en tilkobling gjennom hele forespørselen,
inkludert ventetid på SFM og NHN. Vurderingen bør tas opp igjen hvis
tilkoblingsmodellen endres.

---

## 5. API og standarder

### 5.1 Norske basisprofiler **[V]**

Profilaget er skilt ut i `src/lib/server/fhir/`, men no-basis-profilene er ikke
lagt inn. De er publisert for R4; systemet bruker R5. Se
[apne-punkter.md](apne-punkter.md).

### 5.2 Full `$validate` mot profiler **[N]**

`EPJ_HAPI_VALIDATE` slår på validering mot HAPI før skriving, men er av som
standard fordi den koster en rundtur per skriving. Med profiler på plass bør det
vurderes å ha den på for skriving fra eksterne apper, og av for journalens egen.

### 5.3 Bulk Data Access **[N]**

FHIR Bulk Data (`$export`) er ikke implementert. Det er den etablerte veien for
uttrekk til kvalitetsregistre og forskning, og ville gitt punkt 4.2 mesteparten
av det som trengs.

### 5.4 Subscriptions **[N]**

FHIR Subscription er ikke implementert. Ville latt SMART-apper få beskjed om
endringer i stedet for å spørre gjentatte ganger.

### 5.5 SMART on FHIR: gjenstående deler **[N]**

Implementert: App Launch v2 med v1-kompatibilitet, EHR- og standalone launch,
Backend Services med `private_key_jwt`, `.well-known/smart-configuration`.

Ikke implementert: `smart-app-state` (appers lagring av tilstand), SMART Web
Messaging, og Token Introspection for eksterne ressursservere. Kontroller også
implementasjonsguiden fra Helsenorge punkt for punkt; se
[smart-on-fhir.md](smart-on-fhir.md).

---

## 6. Kvalitet

### 6.1 Tilgjengelighet (WCAG) **[V]**

Grensesnittet er bygget med semantisk HTML, skjemaetiketter, ledetekster og
`aria-current` i navigasjonen, og virker uten JavaScript. Men det er ikke
gjennomgått mot WCAG 2.1 AA, ikke testet med skjermleser, og ikke testet med
tastaturnavigasjon alene. Offentlige og offentlig finansierte tjenester er
underlagt kravet.

### 6.2 Automatisk tilgjengelighetstest i CI **[N]**

Legge `axe-core` inn i Playwright-kjøringen, slik at åpenbare brudd fanges ved
hver endring.

### 6.3 Mutasjonstesting av tilgangsmodellen **[N]**

Tilgangsmodellen har god testdekning, men dekning måler bare at koden ble kjørt.
Mutasjonstesting (Stryker) på `authz/` og `fhir/gateway.ts` ville vist om
testene faktisk fanger endringer i beslutningene.

### 6.4 Penetrasjonstesting **[K]**

Ikke gjennomført. Må gjøres av noen andre enn den som har bygget systemet, før
klinisk bruk.

### 6.5 Kjøre testsuiten mot ekte HAPI i utviklingsmiljøet **[V]**

CI-jobben `integrasjon-hapi` kjører testene mot `hapiproject/hapi`, men det er
ikke kjørt lokalt i utviklingsmiljøet (ingen Docker-motor tilgjengelig).
Partisjoneringen er testet mot en partisjonsbevisst testdobbel over ekte HTTP -
det er ikke det samme som mot HAPI selv. Se [apne-punkter.md](apne-punkter.md).

Utrullingen i september 2026 viste hva forskjellen koster. Testdobbelen godtok
partisjonsstien `/fhir/<virksomhet>/` uten videre; HAPI selv svarte 404 «Unknown
resource type», fordi partisjoneringen aldri ble slått på. Manifestene satte
den med miljøvariabler HAPI ikke leser. Det ble ikke fanget av noen test, fordi
ingen test snakker med den ekte serveren slik den er konfigurert i drift.

Det som mangler er en test som starter HAPI med *manifestenes egen*
konfigurasjon og kontrollerer at partisjonsstien svarer.

### 6.6 Kontrakttest av manifestenes HAPI-konfigurasjon **[V]**

Følger av 6.5. To feil i `04-hapi.yaml` overlevde all testing fordi de bare
finnes i manifestet:

1. Dialekten ble ikke satt, så HAPI bygde skjemaet med `clob`/`blob`.
2. Partisjoneringen ble ikke slått på, så `/fhir/<virksomhet>/` svarte 404.

Begge kommer av det samme: Spring kan ikke uttrykke nøkler med punktum eller
understrek gjennom miljøvariabler. Rettet ved å bruke `SPRING_APPLICATION_JSON`.
En test som starter bildet med manifestets miljø og sjekker
`/fhir/standard/metadata` ville fanget begge på under et minutt.

---

## 7. Mindre ting

- Søk i journalnotater. I dag kan man bla, ikke søke i tekst.
- Utskrift av enkeltnotat. Journalutleveringen tar hele journalen eller en
  periode; noen ganger trengs bare ett notat.
- Maler for journalnotater per behandler.
- Hurtigtaster i journalen.
- Mørk drakt. Fargevariablene er på plass i `app.css`, men ikke ferdigstilt.
- Eksport av regningskort til regnskapssystem (SAF-T).
- Vedlegg i dialogmeldinger (PDF, bilder).
- Flerspråklig grensesnitt. I dag bokmål; nynorsk og samisk er aktuelle.
- Visning av hvem som er pålogget akkurat nå, for systemansvarlig.
- «Åpne i ny fane» for SMART-apper med bevart pasientkontekst.
