# Åpne punkter

Det som må avklares, verifiseres eller bygges ferdig før systemet kan brukes på
ekte pasientopplysninger. Punktene står her i stedet for å være skjult i
kravdokumentet.

## Må avklares med oppdragsgiver

### «HSPI FHIR R5»

Oppdraget spesifiserte «hspi fhir R5». Forkortelsen lot seg ikke gjenfinne i
norsk e-helsedokumentasjon, hos HL7 Norge, i Helsedirektoratets referansekatalog
eller på Simplifier. Systemet er derfor bygget på **HL7 FHIR R5** slik den er
publisert av HL7 International, med norske identifikatorsystemer og
kodeverks-OID-er, og med profilaget skilt ut i `src/lib/server/fhir/` slik at en
konkret implementasjonsguide kan legges inn uten å røre resten.

Om «HSPI» viser til en bestemt implementasjonsguide, trengs navn eller URL for å
legge den inn.

### FHIR-versjon og norske basisprofiler

De norske basisprofilene fra HL7 Norge er publisert for **R4**. Systemet bruker
**R5**, som har den modellen journalen trenger for `Encounter`,
`MedicationRequest` og `Claim` uten utvidelser. Før produksjon må det avklares
om profilene skal tilpasses R5, eller om systemet skal ned til R4. Valget
påvirker `searchparams.ts`, `validate.ts` og HAPI-konfigurasjonen, men ikke
tilgangsmodellen.

## Må verifiseres mot kilde

### Takstbeløp

Alle takster i `src/lib/server/integrasjoner/helfo/takster.ts` er merket
`verifisert: false`. Beløpene er et arbeidsgrunnlag, ikke hentet fra tariffen.
Normaltariff for privat allmennpraksis forhandles årlig og trer i kraft 1. juli,
med enkelte endringer 1. januar.

Før produksjon: oppdater `refusjonOre` og `egenandelOre` fra gjeldende tariff,
sett `TAKSTREGISTER_GYLDIG_FRA`, og fjern `verifisert: false`. Testen
«markerer alle beløp som uverifiserte» i `tests/takster.test.ts` skal da endres —
den står der nettopp som en påminnelse.

Egenandelstaket i `helfo/egenandel.ts` (`EGENANDELSTAK_ORE`) fastsettes årlig og
må oppdateres på samme måte.

### Kodeverks-OID-er

Personidentifikatorene og de kliniske kodeverkene i
`src/lib/server/fhir/kodeverk.ts` er kontrollert. Disse er ikke verifisert mot
Volven, og står i `IKKE_VERIFISERTE_SYSTEMER`:

* takstkoder (`urn:oid:2.16.578.1.12.4.1.1.8214`),
* meldingstyper (`urn:oid:2.16.578.1.12.4.1.1.8279`),
* NCMP (`urn:oid:2.16.578.1.12.4.1.1.7280`).

### Meldingsformatene

Hodemelding, dialogmelding, henvisning, epikrise og applikasjonskvittering er
bygget etter KITH-standardenes struktur, men er ikke validert mot XSD-ene.
Kodeverksreferanser (8127 dialogtema, 8221 AppRec-feilkoder, 9051
identifikatortyper) må kontrolleres mot gjeldende meldingsbeskrivelser, og
meldingene må godkjennes av Norsk helsenett før produksjonssetting.

### Oppgjørsfilen til KUHR

`byggOppgjorsfil()` følger hovedstrukturen for regningskort, men feltnavn og
kodeverksreferanser må kontrolleres mot Helfos gjeldende meldingsbeskrivelse.

### EPJ-standarden

Samsvarstabellen i [epj-standard.md](epj-standard.md) følger temainndelingen i
standarden, ikke kravnumrene, fordi standardteksten ikke har vært tilgjengelig
under utviklingen. Hvert punkt må kontrolleres mot standarden før en formell
samsvarserklæring.

## Ikke ferdig implementert

### Vedtaksflyt for endelig sletting

`slettEndelig()` finnes i koden, men er bevisst ikke eksponert i grensesnittet.
Sletting etter helsepersonelloven § 43 forutsetter et dokumentert vedtak, og
skal ikke være en knapp i journalen. Det som mangler er registrering av
begjæring, vurdering, vedtak og eventuell klage — og at selve slettingen
utføres av den som har myndighet.

### Automatisk sletting av logg etter oppbevaringstiden

`config.audit.retentionYears` er definert, men ingen jobb sletter gamle
innslag. Sletting må også ta hensyn til hash-kjeden: en sletting som bryter
kjeden må skje på en måte som fortsatt lar resten verifiseres.

### Jobbplanlegging

Funksjonene for meldingskø, opprydding og loggverifisering finnes, men kalles
ikke periodisk. De må kobles til en planlegger. Alle er trygge å kjøre parallelt;
`sendKo()` bruker rådgivende lås.

### Kontrasignering

Rollen `turnuslege` er definert som en rolle hvis notater kan kreve
kontrasignering, men selve flyten er ikke bygget.

### Interaksjonsdatabase

SFM-simulatoren har fire kjente interaksjoner, nok til å vise varslingsflyten.
I `live`-modus kommer varslene fra SFM. Skal journalen gi egne varsler, trengs en
klinisk vedlikeholdt kilde.

### Timebok

`Appointment`, `Schedule` og `Slot` er støttet på API-et, og timer vises på
arbeidsflaten, men det finnes ingen timebok med kalendervisning og booking.

### Innbyggerflate

Rollen `pasient` er definert med `patient/`-scope mot egen journal og innsyn i
egen logg, men det er ikke bygget et eget innbyggergrensesnitt. Innbyggere vil
normalt komme via Helsenorge.

## Ikke verifisert i drift

### HelseID

Klienten er implementert etter spesifikasjonen: OIDC med autorisasjonskode,
PKCE, `private_key_jwt`, verifisering av `iss`, `aud` og `nonce`, og krav om
sikkerhetsnivå 4. Signering og verifisering er dekket av enhetstester, men
klienten er ikke kjørt mot NHN sitt testmiljø. Det krever registrert klient og
nøkkel.

### HAPI FHIR

Utviklingsmiljøet hadde ikke tilgjengelig Docker-motor, og Docker Hub sitt
blob-CDN var blokkert av nettverkspolicyen. HAPI er derfor konfigurert i
`docker-compose.yml`, og CI-jobben `integrasjon-hapi` kjører testsuiten mot ekte
`hapiproject/hapi` — men det er ikke verifisert lokalt i dette miljøet.
Kontrakten mot FHIR REST er testet over ekte HTTP mot en testdobbel som
implementerer den delen av protokollen klienten bruker.

Kjør `npm test` med `EPJ_HAPI_BASE_URL` mot en ekte HAPI-instans for å bekrefte.

### Ytelse

Systemet er ikke lastet. `Patient/$everything` med 400 ressurser og
avgrensning på mange pasienter er de to stedene som først vil trenge
oppmerksomhet.

## Krav til virksomheten

Programvaren dekker ikke alt Normen krever. Før klinisk bruk må virksomheten
minst:

* gjennomføre risikovurdering og personvernkonsekvensvurdering,
* inngå databehandleravtaler med leverandører av registrerte apper,
* etablere rutine for gjennomgang av nødrettsoppslag, og faktisk følge den,
* etablere rutine for avvikshåndtering og varsling til Datatilsynet,
* sette opp sikkerhetskopi med testet gjenoppretting,
* avklare tilgang til Helsenettet, SFM og direkte oppgjør med Helfo,
* opprette autorisasjonsregister og rutine for tildeling og fjerning av roller.
