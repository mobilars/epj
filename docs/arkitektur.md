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
  integrasjoner/
    sfm/                 Sentral forskrivningsmodul
    nhn/                 hodemelding, fagmeldinger, AppRec, kø
    helfo/               takster, regningskort, oppgjør, frikort
src/routes/
  fhir/[...sti]/         FHIR R5-endepunktet
  oauth/                 autorisasjon, token, introspeksjon, JWKS
  .well-known/           SMART- og OpenID-oppsett
  pasienter/[id]/        journalen
  meldinger/, oppgjor/, admin/
```
