# Kravdokument

Systemet er en elektronisk pasientjournal for allmennpraksis. Kravene under er
utledet fra regelverket som gjelder for journalsystemer i Norge, og fra det en
fastlegepraksis faktisk trenger for å komme gjennom en arbeidsdag.

Hvert krav har en identifikator, en begrunnelse, og en henvisning til hvor det
er realisert og hvor det er testet. Krav som ennå ikke er innfridd står i
[åpne punkter](apne-punkter.md), ikke skjult her.

## Regelverk kravene bygger på

| Kilde | Hva den styrer |
| --- | --- |
| Pasientjournalloven | Behandling av helseopplysninger, tilgang, innsyn, sperring |
| Helsepersonelloven §§ 21 a, 39–41, 43 | Forbud mot urettmessig tilegnelse, dokumentasjonsplikt, retting og sletting |
| Pasientjournalforskriften | Krav til innhold, endringssporing og oppbevaring |
| Personvernforordningen (GDPR) | Behandlingsgrunnlag, innebygd personvern, den registrertes rettigheter |
| Norm for informasjonssikkerhet og personvern i helse- og omsorgssektoren | Sektorens omforente sikkerhetskrav |
| EPJ-standard: Tilgangsstyring, retting og sletting (Helsedirektoratet) | Rollebasert tilgang, tjenstlig behov, retting, sletting, sperring |
| HITR 1225: Anbefaling om bruk av SMART on FHIR | Tredjepartsapper mot journalsystemer |
| Forskrift om pasientjournal / e-resept | Forskrivning og Pasientens legemiddelliste |
| Folketrygdloven kap. 5 og egenandelsforskriften | Refusjon, egenandel og frikort |

Formuleringen «skal» er brukt der kravet følger av regelverket, «bør» der det er
en faglig anbefaling systemet følger.

---

## 1. Journal og dokumentasjon

**K-1.1 Journalen skal føres elektronisk og være strukturert etter FHIR R5.**
Kliniske opplysninger lagres som FHIR-ressurser, ikke som fritekst i et
proprietært format. Det gjør innholdet gjenbrukbart, søkbart og delbart uten
konvertering.
*Realisert:* HAPI FHIR R5 som lager, `src/lib/server/fhir/`.
*Testet:* `tests/gateway.test.ts`.

**K-1.2 Journalnotat skal kunne skrives, signeres og knyttes til en kontakt.**
Notatet lagres som `Composition` med seksjonene subjektivt, objektivt, vurdering
og plan, knyttet til `Encounter` og eventuell kontaktdiagnose (`Condition`).
*Realisert:* `src/routes/pasienter/[id]/notater/`.
*Testet:* `e2e/journal.spec.ts`.

**K-1.3 Journalinnhold skal ikke kunne endres sporløst.**
Hver endring gir ny versjon; forrige versjon beholdes. HAPI fører
versjonshistorikken, og forfatteren merkes på ressursen.
*Realisert:* `medProvenance()` i `src/lib/server/fhir/gateway.ts`.
*Testet:* `tests/gateway.test.ts`.

**K-1.4 Feilføring skal rettes, ikke slettes.**
Et notat som er ført feil merkes `entered-in-error` med begrunnelse. Innholdet
blir stående. Endelig sletting krever eget vedtak (K-6.4).
*Realisert:* handlingen `feilfor` i `notater/+page.server.ts`.
*Testet:* `e2e/journal.spec.ts`.

**K-1.5 Journalen skal gi et klinisk oversiktsbilde.**
Diagnoser, kritisk informasjon, legemidler i bruk, siste målinger, notater og
kontakter samlet på én side, bygget på `Patient/$everything`.
*Realisert:* `src/routes/pasienter/[id]/+page.server.ts`.
*Testet:* `e2e/journal.spec.ts`.

**K-1.6 Pasientens identitet skal vises kontinuerlig når journalen er åpen.**
Pasientbanner med navn, maskert fødselsnummer, alder og kjønn, festet øverst.
Ved nødrettstilgang skifter banneret farge og merkes.
*Realisert:* `src/routes/pasienter/[id]/+layout.svelte`.
*Testet:* `e2e/journal.spec.ts`, `e2e/tilgang.spec.ts`.

**K-1.7 Fødselsnummer skal valideres før det lagres.**
Mod11-kontroll på begge kontrollsiffer, kontroll av datodel, og støtte for
D-nummer og H-nummer.
*Realisert:* `src/lib/server/fhir/kodeverk.ts`.
*Testet:* `tests/kodeverk.test.ts`.

**K-1.8 Fødselsnummer skal ikke eksponeres unødig.**
Vises maskert i grensesnittet, sendes aldri i URL-er (søk går som `POST
_search`), og maskeres i sikkerhetsloggens søkestrenger.
*Realisert:* `renseForLogg()` i `gateway.ts`, `maskerPersonnummer()`.
*Testet:* `tests/gateway.test.ts`.

## 2. Tilgangsstyring

**K-2.1 Tilgang skal styres av rolle.**
Elleve roller med definerte rettigheter og maksimale scope. Systemansvarlig har
ingen klinisk lesetilgang; personvernombudet har logg, ikke journal.
*Realisert:* `src/lib/server/authz/roles.ts`.
*Testet:* `tests/brukere.test.ts`, `e2e/tilgang.spec.ts`.

**K-2.2 Tilgang skal kreve tjenstlig behov.**
Utover rollen kreves en dokumentert behandlingsrelasjon til den enkelte pasient.
Uten relasjon gis ingen tilgang, og pasienten vises ikke i søk.
*Realisert:* `care_relationship`, `tillattePasienter()` i `authz/tilgang.ts`.
*Testet:* `tests/tilgang.test.ts`, `e2e/tilgang.spec.ts`.

**K-2.3 Søk skal avgrenses, ikke etterfiltreres i grensesnittet.**
Avgrensningen legges inn i selve spørringen mot FHIR-serveren. Et bredt søk kan
ikke returnere pasienter brukeren mangler relasjon til.
*Realisert:* `sokRessurser()` i `gateway.ts`.
*Testet:* `tests/gateway.test.ts`.

**K-2.4 Pasienten skal kunne sperre journalen.**
Sperring mot en navngitt bruker, mot en rolle, mot alle, eller mot et enkelt
dokument. Sperrede pasienter filtreres også bort fra søkeresultater.
*Realisert:* `journal_sperring`, `erSperret()`, `sperredePasienter()`.
*Testet:* `tests/tilgang.test.ts`, `e2e/tilgang.spec.ts`.

**K-2.5 Nødrettstilgang skal finnes, og den skal koste noe.**
Krever begrunnelse på minst 15 tegn, ny bekreftelse av engangskode, og varer
fire timer. Oppslaget merkes `ETREAT` i loggen og legges i kø for gjennomgang.
Nødrett overstyrer tjenstlig behov og sperring, men aldri scope eller rolle.
*Realisert:* `break_glass`, `src/routes/pasienter/[id]/nodrett/`.
*Testet:* `tests/tilgang.test.ts`, `e2e/tilgang.spec.ts`.

**K-2.6 Tilgangsbeslutningen skal tas ett sted.**
Journalens eget grensesnitt går gjennom nøyaktig samme vokter som eksterne
apper. Det finnes ingen intern vei utenom.
*Realisert:* `src/lib/server/fhir/internt.ts` kaller `gateway.utfor()`.
*Testet:* `tests/gateway.test.ts`.

**K-2.7 Innbygger skal kunne se sin egen journal, men ikke endre den.**
Rollen `pasient` gir bare `patient/`-scope mot egen journal, og ingen
skriverettigheter.
*Realisert:* `roles.ts`, `egenPasientId()` i `authz/context.ts`.
*Testet:* `tests/tilgang.test.ts`.

## 3. Autentisering

**K-3.1 HelseID skal være primær påloggingsmekanisme.**
OIDC-klient med autorisasjonskode, PKCE og `private_key_jwt`. Sikkerhetsnivå 4
kreves. Brukere kobles på HPR-nummer ved første pålogging.
*Realisert:* `src/lib/server/auth/helseid.ts`.
*Testet:* `tests/jws.test.ts` (signatur og verifisering), manuell verifisering mot HelseID testmiljø gjenstår.

**K-3.2 Nye brukere skal ikke få tilgang automatisk.**
En bruker som logger inn med HelseID for første gang opprettes uten roller og
uten tilgang. Rolletildeling er en administrativ handling som loggføres.
*Realisert:* `koblePaLokalBruker()`, `/ingen-tilgang`.
*Testet:* `tests/brukere.test.ts`.

**K-3.3 Lokal pålogging skal kunne slås av.**
Brukernavn, passord og engangskode finnes for testmiljø og som reserveløsning,
og styres av `EPJ_TESTINNLOGGING`.
*Realisert:* `src/routes/logg-inn/`.
*Testet:* `e2e/palogging.spec.ts`.

**K-3.4 Totrinnsverifisering skal kreves.**
TOTP etter RFC 6238. Hemmeligheten lagres kryptert med AES-256-GCM.
*Realisert:* `src/lib/server/auth/totp.ts`, `brukere.ts`.
*Testet:* `tests/totp.test.ts` (RFC-vektorer), `tests/brukere.test.ts`.

**K-3.5 Kontoen skal låses etter gjentatte feilforsøk.**
Fem forsøk gir midlertidig utestengelse. Feilmeldingen er lik for ukjent bruker
og feil passord, slik at systemet ikke røper hvem som finnes.
*Realisert:* `loggInn()` i `brukere.ts`.
*Testet:* `tests/brukere.test.ts`, `e2e/palogging.spec.ts`.

**K-3.6 Sesjoner skal ha både inaktivitetsgrense og absolutt levetid.**
30 minutter inaktiv, 12 timer totalt. Cookien er HttpOnly, SameSite=Strict og
Secure. Feil token på gyldig sesjons-id avslutter sesjonen.
*Realisert:* `src/lib/server/auth/session.ts`.
*Testet:* `tests/brukere.test.ts`.

**K-3.7 Tilgang skal kunne trekkes tilbake umiddelbart.**
Deaktivering av en bruker avslutter alle sesjoner og trekker tilbake alle
utstedte tokens.
*Realisert:* `settStatus()`, `tilbakekallForBruker()`.
*Testet:* `tests/brukere.test.ts`, `tests/oauth.test.ts`.

## 4. API og tredjepartsapper

**K-4.1 All funksjonalitet skal være tilgjengelig gjennom API-et.**
Kliniske data via FHIR R5. Administrasjon, meldinger og oppgjør er speilet som
FHIR-ressurser (`Communication`, `DocumentReference`, `ServiceRequest`,
`MedicationRequest`, `Claim`), slik at ingenting bare finnes i grensesnittet.
*Realisert:* `src/routes/fhir/[...sti]/`, integrasjonsmodulene.
*Testet:* `tests/integrasjoner.test.ts`, `e2e/smart.spec.ts`.

**K-4.2 API-et skal følge SMART on FHIR.**
`.well-known/smart-configuration`, EHR launch og standalone launch,
launch-kontekst, `fhirUser`, `smart_style_url`, scope-versjon 1 og 2.
*Realisert:* `src/routes/.well-known/`, `auth/oauth.ts`, `authz/scopes.ts`.
*Testet:* `e2e/smart.spec.ts`, `tests/scopes.test.ts`.

**K-4.3 OAuth-serveren skal følge OAuth 2.1.**
PKCE med S256 er påkrevd for alle klienter. `redirect_uri` sammenliknes eksakt.
Autorisasjonskoden er engangs; gjenbruk trekker tilbake alt som er utstedt.
Refresh tokens roteres, og gjenbruk trekker tilbake hele familien.
*Realisert:* `src/lib/server/auth/oauth.ts`, `tokens.ts`.
*Testet:* `tests/oauth.test.ts`, `e2e/smart.spec.ts`.

**K-4.4 En app skal aldri få mer tilgang enn brukeren har.**
Forespurte scope snevres inn mot både klientregistreringen og brukerens rolle,
på nytt på serversiden når samtykket sendes inn.
*Realisert:* `snevreInn()` i `scopes.ts`, handlingen `godkjenn`.
*Testet:* `tests/scopes.test.ts`, `e2e/smart.spec.ts`.

**K-4.5 Samtykkedialogen skal være forståelig.**
Hver tilgang forklares på norsk, pasienten navngis, og tilganger rollen ikke gir
vises som avvist. Manglende databehandleravtale varsles.
*Realisert:* `beskrivScope()`, `src/routes/oauth/authorize/+page.svelte`.
*Testet:* `e2e/smart.spec.ts`.

**K-4.6 Tjeneste-til-tjeneste-tilgang skal bruke asymmetrisk klientautentisering.**
`client_credentials` krever `private_key_jwt`, og gir bare `system/`-scope.
`jti` kan ikke gjenbrukes.
*Realisert:* `autentiserKlient()`, token-endepunktet.
*Testet:* `tests/oauth.test.ts`.

**K-4.7 Apper skal registreres, og kunne sperres.**
Registrering er administrativ og loggført. Sperring trekker samtidig tilbake
alle appens tokens.
*Realisert:* `src/routes/admin/apper/`.
*Testet:* `tests/oauth.test.ts`.

**K-4.8 API-et skal ikke lekke informasjon i feilmeldinger.**
Feil returneres som `OperationOutcome`. Interne detaljer logges på serveren;
klienten får en korrelasjons-id.
*Realisert:* `outcome.ts`, `handleError` i `hooks.server.ts`.
*Testet:* `e2e/smart.spec.ts`.

## 5. Sikkerhetslogg

**K-5.1 Alle oppslag og endringer skal logges.**
Hvert API-kall gir et FHIR `AuditEvent` med hvem, hva, når, hvilken pasient,
hvilken app, fra hvilken adresse, og med hvilket formål. Avviste forsøk logges
også.
*Realisert:* `src/lib/server/audit/index.ts`, kalt fra `gateway.ts`.
*Testet:* `tests/audit.test.ts`, `tests/gateway.test.ts`.

**K-5.2 Loggen skal ikke kunne endres.**
Databasen avviser `UPDATE` og `DELETE` med en trigger. I tillegg er radene
lenket med SHA-256, slik at fjerning eller endring oppdages ved verifisering.
*Realisert:* migrasjon `001_init.sql`, `verifiserLoggkjede()`.
*Testet:* `tests/audit.test.ts`.

**K-5.3 Pasienten skal kunne få innsyn i loggen.**
Egen innsynslogg per pasient, med hvem som har hatt tilgang, når, og om
oppslaget var nødrett.
*Realisert:* `src/routes/pasienter/[id]/logg/`.
*Testet:* `e2e/journal.spec.ts`.

**K-5.4 Nødrettsoppslag skal gjennomgås.**
Oppslag merket `ETREAT` som ikke er gjennomgått vises på systemansvarliges
oversikt til de er kvittert ut.
*Realisert:* `ugjennomgattNodrett()`, `/admin`.
*Testet:* `tests/audit.test.ts`, `e2e/tilgang.spec.ts`.

**K-5.5 Loggen skal bevares.**
Oppbevaringstid er konfigurerbar, med ti år som utgangspunkt.
*Realisert:* `config.audit.retentionYears`.
*Merk:* automatisk sletting etter oppbevaringstiden er ikke implementert, se
[åpne punkter](apne-punkter.md).

## 6. Retting, sletting og innsyn

**K-6.1 Pasienten skal kunne be om retting.**
Retting gjøres som ny versjon; den opprinnelige teksten består og er synlig i
versjonshistorikken.
*Realisert:* versjonering i HAPI, `skrivRessurs()`.

**K-6.2 Retting skal ikke kunne skjules.**
Versjonshistorikken er tilgjengelig via `[type]/[id]/_history` for de som har
tilgang til ressursen.
*Realisert:* `ressurshistorikk()` i `gateway.ts`.

**K-6.3 Feilført innhold skal merkes.** Se K-1.4.

**K-6.4 Endelig sletting skal kreve vedtak.**
Funksjonen finnes, men er ikke koblet til grensesnittet: sletting etter
helsepersonelloven § 43 forutsetter et dokumentert vedtak, og skal ikke være en
knapp i journalen.
*Realisert:* ikke eksponert. Se [veikartet](todo.md) punkt 1.1.

**K-6.5 Pasienten skal kunne få kopi av journalen sin.**
Utlevering gir det samme innholdet i to former: et FHIR-dokument (`Bundle` av
typen `document` med en `Composition` først, seksjoner kodet med LOINC) og en
lesbar utskrift i HTML eller ren tekst. Den lesbare utgaven er selvstendig -
ingen skript, ingen eksterne ressurser - og har egen utskriftsstil.
Pasient- og brukerrettighetsloven § 5-1.
*Realisert:* `src/lib/server/journal/utlevering.ts`,
`src/routes/pasienter/[id]/utlevering/`.
*Testet:* `tests/utlevering.test.ts`, `e2e/utlevering.spec.ts`.

**K-6.6 Journalen skal kunne overføres til en annen behandler.**
Det samme uttrekket, med hjemmelen «overføring til annen behandler» og
`purposeOfUse` `TREAT`. FHIR-dokumentet er formatet et annet journalsystem kan
lese maskinelt. Utleveringen kan avgrenses i tid.
Pasientjournalforskriften § 12.
*Testet:* `tests/utlevering.test.ts`.

**K-6.7 En utlevering skal ikke gi mer enn utleveren selv har tilgang til.**
Uttrekket hentes gjennom vokteren. Sperret materiale faller bort på samme måte
som ellers, og utskriften opplyser om at det kan ha skjedd.
*Testet:* `tests/utlevering.test.ts` («nekter utlevering uten
behandlingsrelasjon», «tar ikke med andre pasienters opplysninger»).

**K-6.8 Utlevering skal være sporbar.**
Hver utlevering loggføres med hjemmel som `purposeOfUse` (`PATRQT` ved innsyn,
`TREAT` ved overføring, `HLEGAL` på rettslig grunnlag), mottaker, periode og en
telling av hva som faktisk ble utlevert. Pasienten ser utleveringene i sin egen
innsynslogg.
*Testet:* `tests/utlevering.test.ts`, `e2e/utlevering.spec.ts`.

## 7. Legemidler og e-resept

**K-7.1 Forskrivning skal gå gjennom Sentral forskrivningsmodul.**
SFM er kilden til Pasientens legemiddelliste og veien til Reseptformidleren.
*Realisert:* `src/lib/server/integrasjoner/sfm/`.
*Testet:* `tests/integrasjoner.test.ts`, `e2e/journal.spec.ts`.

**K-7.2 Resepter skal være synlige i journalen og på API-et.**
Hver resept speiles som `MedicationRequest`.
*Testet:* `tests/integrasjoner.test.ts`.

**K-7.3 Legen skal varsles om interaksjoner og dobbeltforskrivning.**
Varslene vises ved forskrivning.
*Testet:* `tests/integrasjoner.test.ts`, `e2e/journal.spec.ts`.
*Merk:* interaksjonsdatabasen i denne implementasjonen er et lite utvalg for å
vise flyten. Produksjon krever en fullstendig kilde — se [åpne punkter](apne-punkter.md).

**K-7.4 Avvik mellom journal og legemiddelliste skal synliggjøres.**
Avvik listes øverst på legemiddelsiden.
*Realisert:* `Legemiddelliste.avvik`.

## 8. Meldingsutveksling

**K-8.1 Journalen skal sende og motta helsemeldinger over Helsenettet.**
Henvisning, epikrise, dialogmelding og laboratorierekvisisjon, pakket i
hodemelding etter KITH-standarden.
*Realisert:* `src/lib/server/integrasjoner/nhn/`.
*Testet:* `tests/xml-meldinger.test.ts`, `tests/integrasjoner.test.ts`.

**K-8.2 Mottaker skal kontrolleres før sending.**
Oppslag i Adresseregisteret; melding til en mottaker som ikke støtter
meldingstypen legges ikke i kø.
*Testet:* `tests/integrasjoner.test.ts`.

**K-8.3 En melding er ikke levert før den er kvittert.**
Utgående meldinger følges til applikasjonskvittering foreligger. Meldinger uten
kvittering vises som egen liste.
*Testet:* `tests/integrasjoner.test.ts`.

**K-8.4 Innkommende meldinger skal kobles til pasient og besvares.**
Meldingen kobles på fødselsnummer, speiles som FHIR-ressurs, og besvares med
applikasjonskvittering — med feilkode når pasienten er ukjent.
*Testet:* `tests/integrasjoner.test.ts`.

**K-8.5 Sending skal tåle at mottaker er nede.**
Kø med eksponentiell tilbaketrekking og rådgivende lås, slik at flere
appinstanser ikke sender samme melding to ganger.
*Realisert:* `sendKo()` i `meldingsko.ts`.

## 9. Oppgjør og refusjon

**K-9.1 Takstbruk skal kontrolleres når kortet registreres.**
Kombinasjonsregler, krav om grunntakst, maksimalt antall og spesialistkrav
kontrolleres før lagring, ikke først i Helfos avregning.
*Realisert:* `beregn()` i `helfo/takster.ts`.
*Testet:* `tests/takster.test.ts`, `e2e/oppgjor.spec.ts`.

**K-9.2 Frikort og fritak skal håndteres.**
Frikortstatus hentes fra Helfo; barn under 16, yrkesskade, svangerskap og
allmennfarlig smittsom sykdom gir fritak. Refusjonen påvirkes ikke av fritaket.
*Testet:* `tests/takster.test.ts`, `tests/integrasjoner.test.ts`.

**K-9.3 Oppslag om frikort skal loggføres.**
Oppslaget er en behandling av personopplysninger og logges med formål `HPAYMT`.
*Testet:* `tests/integrasjoner.test.ts`.

**K-9.4 Oppgjør skal kunne sendes og følges opp.**
Regningskort samles i en innsending; avviste kort vises med årsak, slik at de
kan rettes og sendes på nytt.
*Testet:* `tests/integrasjoner.test.ts`, `e2e/oppgjor.spec.ts`.

**K-9.5 Oppgjørsdata skal være tilgjengelige på API-et.**
Hvert regningskort speiles som `Claim`.
*Testet:* `tests/integrasjoner.test.ts`.

## 10. Ikke-funksjonelle krav

**K-10.1 Grensesnittet skal virke uten JavaScript.**
Pålogging, journalføring, forskrivning, meldinger og oppgjør er vanlige
HTML-skjemaer. Hydrering forbedrer, men er ikke nødvendig.
*Testet:* `e2e/`-testene bruker skjemaene direkte.

**K-10.2 Systemet skal ha strenge sikkerhetsheadere.**
CSP settes av rammeverket med nonce, sammen med HSTS, `nosniff`,
`frame-ancestors: none` og en restriktiv `permissions-policy`.
*Realisert:* `svelte.config.js`, `src/lib/server/http.ts`.

**K-10.3 Ratebegrensning skal beskytte påloggings- og API-endepunktene.**
Egne grenser per IP-adresse og per brukernavn, delt mellom appinstanser.
*Testet:* `tests/brukere.test.ts`.

**K-10.4 Hemmeligheter skal ikke ligge i kode.**
All konfigurasjon leses fra miljøvariabler. Obligatoriske verdier feiler ved
første bruk i produksjon, ikke ved bygging.
*Realisert:* `src/lib/server/config.ts`.

**K-10.5 Data at rest skal krypteres der det er mest følsomt.**
TOTP-hemmeligheter og private signeringsnøkler krypteres med AES-256-GCM.
Databasekryptering for øvrig er et driftsansvar.
*Testet:* `tests/crypto.test.ts`.

**K-10.6 Signeringsnøkler skal roteres.**
Nøkler roteres etter konfigurerbar tid. Gamle nøkler blir i JWKS til utstedte
tokens er utløpt, slik at rotasjon ikke gir nedetid.
*Testet:* `tests/oauth.test.ts`.

**K-10.7 Systemet skal kunne overvåkes.**
`/api/helse` rapporterer tilstanden på database og FHIR-server uten å røpe
interne detaljer. Administrasjonssiden viser loggens integritet.
*Realisert:* `src/routes/api/helse/`.

**K-10.8 Kliniske data skal ikke kunne nås utenom vokteren.**
HAPI FHIR ligger på et internt nett uten publiserte porter og uten rute ut.
*Realisert:* `docker-compose.yml`.

**K-10.9 Endringer skal kunne spores i databasen.**
Migrasjoner er versjonerte SQL-filer som kjøres idempotent ved oppstart.
*Realisert:* `src/lib/server/db/migrate.ts`.

**K-10.10 Systemet skal kunne kjøres uten tilgang til nasjonale tjenester.**
`EPJ_INTEGRASJON_MODUS=mock` gir lokale simulatorer for SFM, meldingstjeneren og
Helfo, slik at hele flyten kan øves og testes uten oppkobling.

**K-10.11 Én installasjon skal kunne betjene flere virksomheter.**
Kliniske data skilles av HAPI FHIR sin partisjonering (`URL_BASED`), med
referanser på tvers av partisjoner slått av. Applikasjonsdata skilles av
`tenant_id`, som er `NOT NULL` på alle tabeller som kan inneholde
virksomhetsdata.
*Realisert:* `src/lib/server/tenant/`, migrasjon `003_multitenant.sql`.
*Testet:* `tests/multitenancy.test.ts`.

**K-10.12 Virksomheten skal utledes av systemet, ikke velges av klienten.**
Virksomheten utledes av vertsnavnet i `hooks.server.ts` og legges i en
`AsyncLocalStorage`-kontekst. `krevTenant()` kaster når konteksten mangler, slik
at en spørring som skulle vært avgrenset feiler høylytt i stedet for stille å
hente andres data. Access tokens bærer en `tenant`-påstand som valideres mot
forespørselens virksomhet.
*Realisert:* `src/lib/server/tenant/kontekst.ts`, `src/hooks.server.ts`.
*Testet:* `tests/multitenancy.test.ts`.

**K-10.13 Samme person skal kunne arbeide ved flere virksomheter.**
Brukernavn og HelseID-identitet er unike innenfor virksomheten, ikke globalt.
*Realisert:* per-virksomhet unike indekser i `003_multitenant.sql`.
*Testet:* `tests/multitenancy.test.ts`.

**K-10.14 Hver virksomhet skal ha sin egen sikkerhetslogg og sine egne nøkler.**
Hash-kjeden er per virksomhet, slik at én virksomhet kan verifisere sin egen
kjede uten å se de andres, og tukling i én ikke underkjenner de andre.
Signeringsnøkler og OAuth-`issuer` er også per virksomhet.
*Testet:* `tests/multitenancy.test.ts`.

**K-10.15 Virksomheter skal kunne opprettes og administreres.**
`/systemadmin` oppretter virksomheter med FHIR-partisjon og første
systemansvarlige, suspenderer dem, og krysser registeret mot partisjonene HAPI
faktisk har. Partisjonen opprettes før virksomheten lagres, slik at en
virksomhet aldri peker på en partisjon som ikke finnes. Suspensjon avslutter
sesjoner og trekker tilbake tokens umiddelbart.
*Realisert:* `src/routes/systemadmin/`, `src/lib/server/tenant/tenant.ts`.
*Testet:* `tests/multitenancy.test.ts`.

**K-10.16 Plattformadministrasjon skal ikke gi klinisk innsyn.**
Rollen `systemeier` har ingen scopes, så FHIR-fasaden avviser den uansett.
Grensesnittet er bare tilgjengelig på plattformens eget vertsnavn.
*Realisert:* `authz/roles.ts`, `src/hooks.server.ts`.

**K-10.17 Installasjon skal være dokumentert for Docker og Kubernetes.**
*Realisert:* [installasjon-docker.md](installasjon-docker.md),
[installasjon-kubernetes.md](installasjon-kubernetes.md), `deploy/kubernetes/`.

---

## Sporing

| Område | Krav | Enhetstester | Ende-til-ende |
| --- | --- | --- | --- |
| Journal og dokumentasjon | K-1.1 – K-1.8 | `kodeverk`, `fhir-validering`, `gateway` | `journal.spec.ts` |
| Tilgangsstyring | K-2.1 – K-2.7 | `tilgang`, `scopes`, `brukere` | `tilgang.spec.ts` |
| Autentisering | K-3.1 – K-3.7 | `brukere`, `totp`, `crypto`, `jws` | `palogging.spec.ts` |
| API og apper | K-4.1 – K-4.8 | `oauth`, `scopes`, `gateway` | `smart.spec.ts` |
| Sikkerhetslogg | K-5.1 – K-5.5 | `audit` | `tilgang.spec.ts` |
| Retting, sletting og innsyn | K-6.1 – K-6.8 | `utlevering` | `utlevering.spec.ts` |
| Legemidler | K-7.1 – K-7.4 | `integrasjoner` | `journal.spec.ts` |
| Meldinger | K-8.1 – K-8.5 | `xml-meldinger`, `integrasjoner` | — |
| Oppgjør | K-9.1 – K-9.5 | `takster`, `integrasjoner` | `oppgjor.spec.ts` |
| Multitenancy | K-10.11 – K-10.17 | `multitenancy` | — |
