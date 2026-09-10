# Arkitektur

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

### Vokteren — `src/lib/server/fhir/gateway.ts`

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
lege ──skjema──▶ forskriv() ──▶ SFM (HelseID-maskintoken)
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
src/lib/server/
  config.ts              konfigurasjon fra miljøvariabler
  db/                    PostgreSQL, migrasjoner
  fhir/
    client.ts            tynn HTTP-klient mot HAPI
    gateway.ts           vokteren — eneste vei til kliniske data
    internt.ts           journalens egen inngang, gjennom vokteren
    kodeverk.ts          norske OID-er, fødselsnummer, organisasjonsnummer
    validate.ts          strukturell validering og norske profilregler
    searchparams.ts      søkeparametere og pasientkompartment
    visning.ts           presentasjonshjelpere
  authz/
    roles.ts             rollemodell for et fastlegekontor
    scopes.ts            SMART-scope, parsing og innsnevring
    tilgang.ts           tilgangsbeslutningen
  auth/
    helseid.ts           HelseID som identitetsleverandør
    oauth.ts             autorisasjonskodeflyt
    tokens.ts            utstedelse og validering av tokens
    jws.ts               ES256/RS256/PS256 mot node:crypto
    totp.ts              RFC 6238
  audit/                 hash-lenket sikkerhetslogg
  journal/
    utlevering.ts        journalutskrift i FHIR-dokument og lesbart format
  tenant/
    kontekst.ts          virksomhetskontekst (AsyncLocalStorage)
    tenant.ts            virksomhetsregisteret
    partisjon.ts         partisjonsadministrasjon i HAPI
  integrasjoner/
    sfm/                 Sentral forskrivningsmodul
    nhn/                 hodemelding, fagmeldinger, AppRec, kø
    helfo/               takster, regningskort, oppgjør, frikort
src/routes/
  fhir/[...sti]/         FHIR R5-endepunktet
  oauth/                 autorisasjon, token, introspeksjon, JWKS
  .well-known/           SMART- og OpenID-oppsett
  pasienter/[id]/        journalen
  pasienter/[id]/utlevering/  utlevering av journal
  systemadmin/           plattformadministrasjon, på tvers av virksomheter
  meldinger/, oppgjor/, admin/
```
