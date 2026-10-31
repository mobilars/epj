# Arkitektur

## Plattform og apper

**Målbildet:** Plattformen er rammen, og appene er journalen.

```
┌──────────────────────────────────────────────────────────────────┐
│ APPENE – det klinikeren jobber i                                 │
│                                                                  │
│  Notater · Legemidler · Meldinger · Oppgjør · LIMS · Spirare …   │
│  fra oss eller fra andre leverandører, byttbare per virksomhet   │
└──────────────┬───────────────────────────────────┬───────────────┘
        SMART on FHIR                         CDS Hooks
┌──────────────▼───────────────────────────────────▼───────────────┐
│ PLATTFORMEN – vet ikke hva en resept er                          │
│                                                                  │
│  Ramme og menyer · pasientkontekst · appkatalog og appstyring    │
│  Pålogging (HelseID) · OAuth 2.1 · roller · virksomheter         │
│  /fhir med vokteren: tjenstlig behov, sperring, nødrett, logg    │
└──────────────┬──────────────────────────────────┬────────────────┘
┌──────────────▼───────────────┐  ┌───────────────▼────────────────┐
│ HAPI FHIR R5 – kliniske data │  │ PostgreSQL – identitet, tilgang│
│ én partisjon per virksomhet  │  │ og sikkerhetslogg              │
└──────────────────────────────┘  └────────────────────────────────┘
```

Plattformen skal ikke vite hva en resept er. Den vet hvem du er, hvilken pasient du
står i, hva du har lov til, og hvilke apper virksomheten har valgt.

### Hvor koden ligger

Koden er delt i `src/platform/` og `src/apps/<navn>/`. Alt som hører til en app ligger
i appens mappe, både sider og tjenerkode:

| Hva | Hvor | Kan byttes ut? |
| --- | --- | --- |
| Journalnotater, også hurtignotatet i sidepanelet | `src/apps/notes/` | Ja. Det finnes en demonstrasjonsapp |
| Legemidler | `src/apps/medications/` | Ja. Det finnes en demonstrasjonsapp |
| Sentral forskrivningsmodul | `src/apps/sfm/` | Ja, men trenger legens eget HelseID-token ([sfm.md](sfm.md)) |
| Meldinger | `src/apps/messages/` | Ja, men trenger en tjenerdel med nøkler mot NHN |
| Oppgjør | `src/apps/billing/` | Ja, men trenger en tjenerdel med nøkler mot Helfo |
| Pasientoversikten | `src/apps/overview/` | Ja |
| Beslutningsstøtte | `src/apps/cds-services/` | Ja, gjennom CDS Hooks |
| FHIR-utforskeren | `src/apps/fhir-browser/` | Ja |
| Pålogging, OAuth, FHIR-fasaden med vokteren | `src/platform/` | Nei: dette er det appene står på |
| Administrasjon, utviklerportal, innstillinger, appkatalog | `src/platform/` | Nei |
| Pasientramme, pasientsøk, pasientopplysninger | `src/platform/` | Nei |
| Sperring, nødrett, innsynslogg, utlevering | `src/platform/` | Nei: lovpålagt, skal ikke kunne byttes ut |
| Arbeidsflatens ramme og timeboken, kodeverk | `src/platform/` | Nei |

De ekte eksterne appene ligger ikke i `src/` i det hele tatt. De kjører for seg, på
egne adresser, og demonstrasjonsappene ligger i `deploy/apus/demo-app/`. Appene i
`src/apps/` er i samme kodebase og på samme adresse, men følger de samme grensene,
slik at en virksomhet kan legge en ekstern app i en fane i stedet.

### Slik henger det sammen

SvelteKit leser sider fra bare én mappe, `src/platform/routes/`. Der ligger det derfor
en fil på én linje for hver side en app har, og den peker inn i appens mappe:

```ts
// Mounts the notes app.
export { actions, load } from '$apps/notes/routes/pasienter/[id]/notater/+page.server';
```

Hver app beskriver seg selv i en `manifest.ts`: faner, menypunkter, snarveier og kort.
Plattformen tegner dem uten å ha en egen liste over hva de er.

Plattformen kjenner appene bare gjennom tre filer, som også er det eneste stedet en
app legges til eller fjernes:

| Fil | Innhold |
| --- | --- |
| `src/apps/registry.ts` | Manifestene |
| `src/apps/slots.ts` | Komponenter som vises i plattformens flater: kort og sidepanel |
| `src/apps/registry.server.ts` | Tjenerdelen: data til kortene, varsler, tall til administrasjonen, behov ved pålogging |

`tests/architecture.test.ts` feiler hvis

- plattformen importerer en app på noen annen måte
- en app importerer en annen app uten å ha oppgitt det i `dependsOn` (i dag bare
  legemidler, som viser SFM)
- nettleserkode i en app importerer tjenerkode. SvelteKit vokter bare `$lib/server`,
  så denne grensen må testen holde
- en side i en app mangler sin fil i `src/platform/routes/`, eller filen peker på noe
  som ikke finnes
- en app ikke er registrert, eller to apper krever samme fane, tast eller kort

**Eksterne apper** kommer inn gjennom utviklerportalen: en utvikler registrerer appen,
plattformeier godkjenner den, og en virksomhet installerer den fra appgalleriet. En
virksomhet kan også installere en app som venter på vurdering, men da er appen merket
med varseltrekant overalt. Virksomheten kan ikke registrere apper selv.

**Slik legger du til en app i kodebasen:** Lag `src/apps/<navn>/` med `manifest.ts` og `routes/`,
legg manifestet i `registry.ts`, og legg de korte filene i `src/platform/routes/`.
Testen sier fra om det mangler noe.

En app eier også dette, i sin egen mappe:

| Hva | Hvor | Merk |
| --- | --- | --- |
| Tillatelser, og hvilke roller som får dem | `permissions` i `manifest.ts` | Bare for behandler, lab og resepsjon. `tests/role-permissions.test.ts` lister hva hver rolle får, og må endres samtidig |
| Innstillinger per virksomhet | `practiceSettings` i `manifest.ts` | Plattformen lagrer dem og viser feltene på virksomhetens side |
| Miljøvariabler | `server/config.ts` | |
| Tabeller | `migrations/` | Samme nummerrekke som resten av databasen. Neste ledige nummer gjelder på tvers av alle mapper |

### Det som gjenstår

Skillet er håndhevet i importene. Dette ligger fortsatt i plattformen, de fleste med
vilje:

- **FHIR-scopene i rollemodellen** nevner ressurser som `MedicationRequest`. De sier
  hva en rolle får lese og skrive i FHIR, og det gjelder også eksterne apper, så de
  hører til plattformen.
- **`journal:*`-tillatelsene** hører til journalen som helhet og til de lovpålagte
  funksjonene, ikke til notat-appen.
- **Eldre migrasjoner.** Tabellene for meldinger, oppgjør og legemidler ble opprettet i
  migrasjoner som også inneholder plattformens tabeller. Migrasjoner som har kjørt
  skal ikke skrives om, så de blir liggende. Nye tabeller legges hos appen som eier
  dem.
- **Filene i `src/platform/routes/`** som peker inn i appene. SvelteKit krever dem.
- Oversiktskortene er ett skjermbilde i `overview`, som leser kliniske data direkte fra
  FHIR. Andre apper kan ikke bidra med egne kort der ennå.
- Det å bytte ut en innebygd app virker for faner og sidepanel. Hovedmeny, snarveier og
  kort følger den innebygde appen.

Appene i `src/apps/` blir værende i denne kodebasen og på denne tjeneren. Det er ikke
et mål å flytte dem ut. Kravet er at de er tydelig skilt fra plattformen i prosjektet,
og at en virksomhet kan velge en ekstern app i stedet. Se [todo.md](todo.md) punkt 6c.

## Hvorfor grensene går der de går

Systemet er delt i tre, og delingen følger ett prinsipp: **kliniske data skal
bare kunne nås gjennom ett punkt, og det punktet skal håndheve norske
tilgangsregler.**

```
                         ┌──────────────────────────────────────┐
  Nettleser ────────────▶│ SvelteKit                            │
  SMART-app ────────────▶│                                      │
  Backend-tjeneste ─────▶│  hooks.server.ts                     │
                         │    · autentisering (sesjon / Bearer) │
                         │    · ratebegrensning                 │
                         │    · sikkerhetsheadere               │
                         │           │                          │
                         │  ┌────────▼─────────┐                │
                         │  │ fhir/gateway.ts  │  vokteren      │
                         │  │  scope → rolle → │                │
                         │  │  tjenstlig behov │                │
                         │  │  → sperring      │                │
                         │  │  → AuditEvent    │                │
                         │  └────────┬─────────┘                │
                         └───────────┼──────────────────────────┘
                                     │  application/fhir+json
                         ┌───────────▼───────────┐
                         │ HAPI FHIR JPA (R5)    │  internt nett
                         │  ressurser, versjoner,│  ingen rute ut
                         │  søk, $everything     │
                         └───────────┬───────────┘
                                     │
                         ┌───────────▼───────────┐   ┌────────────────────┐
                         │ PostgreSQL: HAPI      │   │ PostgreSQL: «epj»  │
                         │  kliniske data        │   │  identitet, roller,│
                         └───────────────────────┘   │  logg, meldinger,  │
                                                     │  oppgjør           │
                                                     └────────────────────┘
```

## Komponentene

### HAPI FHIR — det kliniske lageret

HAPI FHIR JPA-serveren eier FHIR-ressursene, versjonshistorikken,
søkeindeksene, `$everything` og profilvalidering. Den er referanse-
implementasjonen av FHIR, og den gjør FHIR-arbeidet bedre enn en egenskrevet
server ville gjort.

HAPI kjenner ikke norske regler om tjenstlig behov, sperring eller nødrett, og
skal ikke gjøre det. Derfor ligger den på et internt nett uten publiserte porter
og uten rute ut, og all trafikk går gjennom fasaden.

### Vokteren — `src/platform/server/fhir/gateway.ts`

Alt som skal til eller fra kliniske data passerer her. For hver forespørsel:

1. **Scope.** Har tokenet lov til denne operasjonen på denne ressurstypen?
   SMART-scope, versjon 2 med versjon 1-kompatibilitet.
2. **Rolle.** Har stillingskategorien lov til å lese eller skrive i journal?
3. **Tjenstlig behov.** Finnes det en dokumentert behandlingsrelasjon til
   nettopp denne pasienten? For søk legges avgrensningen inn i spørringen, ikke
   i etterkant.
4. **Sperring.** Har pasienten sperret disse opplysningene for denne brukeren,
   rollen eller dette dokumentet?

Nødrett kan overstyre punkt 3 og 4, aldri punkt 1 og 2.

Deretter skrives et `AuditEvent` — også når forespørselen avvises. Uten det
ville avviste forsøk vært usynlige, og de er nettopp det man vil se.

Journalens eget grensesnitt kaller `gateway.utfor()` gjennom
`fhir/internt.ts`. Det finnes ingen intern snarvei: en feil i en løpefunksjon
kan ikke gi mer innsyn enn API-et gir.

### Applikasjonsdatabasen — skjema `epj`

Her ligger det FHIR ikke er laget for: brukere, roller, behandlingsrelasjoner,
sperringer, nødrettsvedtak, OAuth-klienter og tokens, sikkerhetsloggen, og
tilstanden til integrasjonene.

Sikkerhetsloggen er append-only, håndhevet av en databasetrigger, og radene er
lenket med SHA-256. Hashen beregnes over en kanonisk serialisering, fordi
PostgreSQL normaliserer nøkkelrekkefølgen i `jsonb`; uten det ville
verifiseringen slått ut på uskadde rader.

### Applikasjonen — SvelteKit

Ett program dekker tre roller:

* **Journalgrensesnittet** for helsepersonell.
* **Autorisasjonsserveren** (OAuth 2.1 / SMART on FHIR) for tredjepartsapper.
* **Ressursserveren** `/fhir`, som er fasaden foran HAPI.

At autorisasjons- og ressursserveren ligger sammen er et bevisst valg: de deler
tilgangsmodell, og en tilgangsmodell som er beskrevet to steder blir før eller
siden beskrevet forskjellig.

## Dataflyt

### Et FHIR-kall fra en SMART-app

```
app ──GET /fhir/Observation?patient=…──▶ hooks: valider Bearer → AuthContext
                                          │
                                          ▼
                                    gateway.utfor()
                                     scope? rolle? behov? sperring?
                                          │ ja
                                          ▼
                                    POST /Observation/_search  ──▶ HAPI
                                          │
                                    filtrer bort sperrede pasienter
                                          │
                                    skriv AuditEvent
                                          ▼
                                    application/fhir+json
```

### En innkommende henvisning fra Helsenettet

```
meldingstjener ──ebXML/XML──▶ mottaMelding()
                                │
                                ├── les hodemelding, finn pasient på fødselsnummer
                                ├── lagre melding, speil som ServiceRequest i FHIR
                                ├── skriv AuditEvent
                                └── bygg AppRec (status 1, 2 eller 3) ──▶ avsender
```

### En forskrivning

```
lege ──skjema──▶ forskriv() ──▶ SFM-simulator (SFM Full: se sfm.md)
                                  │
                                  ├── reseptid + varsler
                                  ├── speil som MedicationRequest i FHIR
                                  └── AuditEvent + rad i sfm_synk
```

## Multitenancy

Én installasjon betjener flere legekontorer. Skillet går på to steder, og det er
med vilje to forskjellige mekanismer:

**Kliniske data skilles av HAPI.** Hver virksomhet har sin egen partisjon, og med
`URL_BASED` tenantidentifikasjon inngår partisjonsnavnet i FHIR-URL-en:
`/fhir/legekontor-a/Patient/123`. Referanser på tvers av partisjoner er slått av
i serverkonfigurasjonen, så en ressurs i én virksomhet kan ikke peke inn i en
annen - heller ikke ved en feil i vår kode.

**Alt annet skilles av `tenant_id`.** Brukere, roller, sesjoner, tokens,
sikkerhetslogg, meldinger, oppgjør og signeringsnøkler har kolonnen, og den er
`NOT NULL` på alle tabeller som kan inneholde virksomhetsdata.

Virksomheten en forespørsel gjelder utledes av **vertsnavnet** i
`hooks.server.ts`, og legges i en `AsyncLocalStorage`-kontekst for resten av
forespørselen. Brukeren velger aldri virksomhet selv - da ville valget vært en
angrepsflate. `krevTenant()` kaster når konteksten mangler; det er med vilje, så
en spørring som skulle vært avgrenset feiler høylytt i test i stedet for stille
å hente andres data.

Konsekvenser som er verdt å merke seg:

- Brukernavn og HelseID-identitet er unike *innenfor* virksomheten. Samme person
  kan arbeide ved flere legekontorer og har da én konto i hvert.
- Sikkerhetsloggens hash-kjede er per virksomhet. Hver virksomhet kan verifisere
  sin egen kjede uten å se de andres, og tukling i én underkjenner ikke de andre.
- Hver virksomhet har sine egne signeringsnøkler og sin egen OAuth-`issuer`.
  `.well-known`-dokumentene svarer med virksomhetens egne adresser.
- Ratebegrensningen nøkles med virksomheten, så én virksomhets trafikk kan ikke
  stenge ute en annen.

`/systemadmin` er det eneste grensesnittet som ser på tvers. Det gir aldri
klinisk innsyn: rollen `systemeier` har ingen scopes, så FHIR-fasaden avviser den
uansett hva den skulle finne på å spørre om. I produksjon ligger det på sitt eget
vertsnavn.

**Hvorfor ikke Row Level Security?** RLS i PostgreSQL ville flyttet garantien fra
vår kode til databasen, som er sterkere. Det ble valgt bort fordi
virksomhetsvariabelen må settes på tilkoblingen, og da må tilkoblingen holdes
gjennom hele forespørselen - inkludert ventetiden på SFM, NHN og Helfo. Det ville
gjort tilkoblingsbudsjettet til en funksjon av hvor treg Helsenettet er den
dagen. Valget er derfor eksplisitt filtrering overalt, med isolasjonstester som
skriver i én virksomhet og leter i en annen (`tests/multitenancy.test.ts`).
Vurderingen bør tas opp igjen hvis tilkoblingsmodellen endres.

## Utlevering av journal

Pasienten har rett til innsyn i og kopi av egen journal, og journalen skal kunne
overføres til en annen behandler. `journal/utlevering.ts` bygger begge deler av
det *samme* uttrekket, slik at den lesbare og den maskinlesbare utgaven ikke kan
si forskjellige ting:

- et FHIR-dokument (`Bundle` av typen `document` med en `Composition` først),
  delt i seksjoner med LOINC-koder der det finnes en etablert kode,
- en lesbar utskrift i HTML eller ren tekst.

Uttrekket hentes gjennom vokteren. En utlevering gir derfor aldri mer enn den som
utleverer selv har tilgang til - sperret materiale faller bort på samme måte som
ellers, og utskriften sier fra om at det kan ha skjedd. Hjemmelen velges i
skjemaet og havner som `purposeOfUse` i sikkerhetsloggen, sammen med mottaker,
periode og en telling av hva som faktisk ble utlevert.

Uttrekket mellomlagres ikke. Filen bygges på nytt for hver nedlasting, så
helseopplysninger blir aldri liggende utenfor det kliniske lageret.

## Valg som er verdt å begrunne

**FHIR R5, ikke R4.** R5 har den modellen systemet trenger for `Encounter`,
`MedicationRequest` og `Claim` uten utvidelser. De norske basisprofilene er per
i dag publisert for R4; profilene må derfor tilpasses. Se
[åpne punkter](apne-punkter.md).

**FHIR som JSON, XML bare der standarden krever det.** Hele API-et er
`application/fhir+json`. Hodemelding, dialogmelding, henvisning, epikrise og
applikasjonskvittering er XML fordi de nasjonale meldingsstandardene er det.
Innholdet speiles som FHIR, slik at det likevel er tilgjengelig som JSON.

**Søk med `POST _search`.** Fødselsnummer i en URL havner i proxy-logger,
nettleserhistorikk og feilrapporter. Kroppen gjør det ikke.

**Ingen runtime-avhengigheter utover `pg`.** JWS, TOTP, kryptering og
XML-håndtering er skrevet mot Node sitt standardbibliotek. Hver avhengighet i et
system som behandler helseopplysninger er også en forsyningskjederisiko, og
disse er små nok til at det er billigere å eie dem.

**Grensesnittet virker uten JavaScript.** Alt klinisk arbeid gjøres med vanlige
HTML-skjemaer. Hydrering forbedrer opplevelsen, men journalen skal virke på en
treg maskin på et legekontor klokka åtte om morgenen.

## Filstruktur

```
src/hooks.server.ts      inngangen for hver forespørsel
src/platform/            plattformen
  app-manifest.ts        det en app sier om seg selv
  components/            felles komponenter og rammen rundt eksterne apper
  routes/                alle adresser: plattformens egne sider, og korte filer for appenes
  styles/
  server/
    config.ts            konfigurasjon fra miljøvariabler
    db/                  PostgreSQL, plattformens migrasjoner
    fhir/                vokteren (gateway.ts), HAPI-klient, validering, kodeverk
    authz/               rollemodell, SMART-scope, tilgangsbeslutningen
    auth/                HelseID, OAuth, tokens, økter, tilleggene appene ber om ved pålogging
    audit/               hash-lenket sikkerhetslogg
    journal/             pasientopplysninger, utlevering, åpning fra andre programmer
    tenant/              virksomhetskontekst, register, partisjoner i HAPI, appinnstillinger
    terminology/         ICPC-2 og søk i kodeverk
    workspace/           oppsett av arbeidsflate og pasientoversikt
    cds/                 klienten som kaller CDS Hooks
    developer/           utviklerportalen
src/apps/                appene
  registry.ts, slots.ts, registry.server.ts   det eneste plattformen ser av dem
  <navn>/
    manifest.ts          faner, menypunkter, snarveier, kort, tillatelser og innstillinger
    migrations/          appens tabeller
    routes/              appens sider, med samme stier som adressene
    components/          komponenter
    server/              tjenerkode
```
