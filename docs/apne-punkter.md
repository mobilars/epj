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

Delvis avlastet, men ikke avgjort: en R4-formet `DocumentReference` oversettes
til R5 på vei inn, slik at apper som bare finnes i R4-utgave kan skrive til
journalen. Lesing i R4-form er ikke tilbudt, og profilspørsmålet står igjen.

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

### Behandlerens identitet uten `fhirUser`-scope **[avvik]**

SMART knytter behandlerens identitet til scopet `fhirUser`. Journalen oppgir
den uansett: `fhirUser` i id-tokenet, og `smart_app_practitioner` i access-
tokenet og `practitioner` i token-svaret, som er navnene apper skrevet for
WebMed leser.

Valget er bevisst, og har to grunner. Id-tokenet bærer allerede `name` og
`roles` til enhver app med `openid`, så det scopet faktisk holdt tilbake var
ikke identiteten, men referansen som knytter behandleren til en ressurs i
journalen. Og en app som ikke finner den referansen faller tilbake til `sub` i
tokenet - en bruker-id, ikke en Practitioner-id - og skriver en
`DocumentReference` der `author` peker på en ressurs som ikke finnes. En
forfatter som peker i tomme luften er verre enn ingen forfatter, og den sier
ikke fra.

Avviket er verdt å ta opp igjen når appene rundt oss ber om scopet slik
standarden sier. Det er én linje i `tokens.ts` å reversere.

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

Klienten er gjennomgått mot NHNs *Sikkerhetsprofil for HelseID-klienter og
API-er* (sikkerhetskrav SK1–SK10 og SB1–SB6) og *Krav til kryptografi*,
17.9.2026. Kilde: utviklerportal.nhn.no → HelseID → Protokoller og
sikkerhetsprofil.

| Krav | Innhold | Status |
| --- | --- | --- |
| SK1 | Bare TLS, minst 1.2 (1.3 anbefalt) | Oppfylt. Utgående kall bruker Node sin standard (1.2+); inngangen kjører ingress-nginx sin standard (1.2 og 1.3). |
| SK2 | `private_key_jwt`, `exp` høyst 10 s fram | Oppfylt. Levetiden var 10 s og er satt til 5, så klokkeslakk ikke gjør hver innlogging til `invalid_client`. `nbf` settes nå også, slik dokumentet lister kravene. |
| SK3 | Konfidensiell klient, offentlig nøkkel kjent for HelseID | Oppfylt. Nøkkelen ligger bare på tjeneren. |
| SK4/SK5 | Hemmeligheten beskyttes og brukes bare mot HelseID og til DPoP | Oppfylt. Egen nøkkel (`EPJ_HELSEID_PRIVATE_KEY`/`_JWK`), adskilt fra journalens egne signeringsnøkler. |
| SK6 | DPoP for API-tokens | Oppfylt. Nøkkelpar per innlogging, `dpop_jkt` i PAR, bevis på token- og userinfo-kallet. |
| SK7/SK8 | Token bare i `Authorization`, aldri til sluttbruker | Oppfylt. Tokenene forlater ikke tjeneren; brukeren får journalens egen sesjon. |
| SK10 | OWASP Topp 10 | Dekket av CSP, CSRF-vern, sikkerhetshoder og ratebegrensning. Ikke penetrasjonstestet — se todo.md 6.4. |
| SB1 | Authorization code, `response_type=code` | Oppfylt. |
| SB2 | PKCE med S256, unik `code_challenge` | Oppfylt. |
| SB3 | PAR | Oppfylt. |
| SB4 | Validering av ID-token | Oppfylt via openid-client 6.8: `iss`, `aud`, `nonce`, `exp`, signatur mot JWKS. |
| SB5 | Lokal og HelseID-identitet må være samme person | Oppfylt: en lokal konto kobles bare når `pid` eller HPR-nummer stemmer, og bare om den ikke allerede er koblet. |
| SB6 | `iss` i autorisasjonssvaret må være lik `issuer` fra discovery | Oppfylt via openid-client (RFC 9207), som håndhever det når serveren annonserer det — det gjør HelseID. |
| Krypto | PS256/384/512 eller ES256/384/512; PS256 eller PS512 anbefalt; RSA ≥ 2048 bit | **Rettet.** Standardalgoritmen var RS256, som ikke står på listen; den er nå PS256, og en konfigurasjon med en algoritme HelseID avviser stoppes ved oppstart med en melding som sier hvilke som er lov. |
| Nivå | Helsepersonell logger inn på sikkerhetsnivå 4 | **Rettet.** Et token *uten* nivå-claim slapp gjennom; det avvises nå, med beskjed om at scopet `helseid://scopes/identity/security_level` må være bedt om og innvilget. |

Ikke gjort: klienten er fortsatt ikke kjørt ende til ende mot NHN sitt
testmiljø med journalens egen klientregistrering. Det er den eneste måten å
bekrefte SB4 og SB6 i praksis på, og det bør gjøres før første virksomhet
tas i bruk med HelseID. Penetrasjonstest (SK10) er et eget punkt.

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
