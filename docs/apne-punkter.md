# Åpne punkter

Det som må avklares eller verifiseres mot en kilde før systemet kan brukes på
ekte pasientopplysninger. Punktene står her i stedet for å være skjult i
kravdokumentet.

Arbeid som skal *gjøres* - funksjonalitet som ikke er bygget ennå - står i
[todo.md](todo.md).

## Må avklares med oppdragsgiver

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

### Implementasjonsguide for SMART on FHIR

Helsenorge har publisert «Implementasjonsguide SMART App Launch Framework», og
HL7 Norge har en anbefaling om SMART App Launch. Begge var utilgjengelige
gjennom utviklingsmiljøets nettverkspolicy, og er derfor **ikke gjennomgått
punkt for punkt**. Implementasjonen følger HL7 SMART App Launch 2.2.0, som er
det de norske guidene bygger på, og de hovedpunktene som lot seg lese ut av
søketreffene stemmer: obligatorisk `launch`-scope sammen med `launch`-parameter
ved EHR launch, `openid`/`fhirUser` for identitet, og `id_token` sammen med
access token.

Før produksjon må guidene gjennomgås i sin helhet. Se
[smart-on-fhir.md](smart-on-fhir.md).

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

Flyttet til [todo.md](todo.md), der de står sammen med resten av veikartet med
en vurdering av hva som må på plass før klinisk bruk.

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

### Multitenancy mot ekte HAPI

Partisjoneringen er testet over ekte HTTP mot en partisjonsbevisst testdobbel
som svarer på `$partition-management`-operasjonene, og isolasjonen mellom
virksomheter er dekket av 32 tester i `tests/multitenancy.test.ts`. Det er ikke
det samme som å ha kjørt mot HAPI selv. Kjør testsuiten med
`EPJ_USE_REAL_HAPI=1` mot en HAPI-instans med
`hapi.fhir.tenant_identification_strategy=URL_BASED` for å bekrefte.

### Ytelse

Systemet er ikke lastet. `Patient/$everything` med 400 ressurser og
avgrensning på mange pasienter er de to stedene som først vil trenge
oppmerksomhet. Journalutleveringen henter opptil 1000 ressurser og bygger
dokumentet i minnet.

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
