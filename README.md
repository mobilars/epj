# EPJ — elektronisk pasientjournal for norske fastleger

Journalsystem for allmennpraksis bygget på **HL7 FHIR R5**, med **HAPI FHIR** som
klinisk lager, **PostgreSQL** som database og **SvelteKit** som applikasjon.
Systemet støtter **SMART on FHIR**-apper, bruker **HelseID** til pålogging, og
har integrasjoner mot **Sentral forskrivningsmodul (SFM)**, **NHN
meldingstjener** og **Helfo**. Én installasjon kan betjene flere legekontorer:
hver virksomhet har sin egen partisjon i HAPI, sine egne brukere, sin egen
sikkerhetslogg og sine egne signeringsnøkler.

> **Status:** fungerende referanseimplementasjon med fullstendig testdekning.
> Den er *ikke* satt i klinisk drift, og flere verdier må verifiseres mot
> gjeldende regelverk før den kan brukes på ekte pasientopplysninger.
> Se [docs/apne-punkter.md](docs/apne-punkter.md).

## Kom i gang

```bash
cp .env.example .env          # fyll ut EPJ_DATA_KEY
docker compose up -d          # PostgreSQL + HAPI FHIR R5 + applikasjonen
npm install
npm run seed                  # demodata: brukere, pasienter, en SMART-app
npm run dev
```

Åpne <http://localhost:5173> og logg inn som `lege` / `Testpassord1!`.
Engangskoden regnes ut fra TOTP-hemmeligheten seed-skriptet skriver ut.

Uten Docker kan du kjøre mot en lokal PostgreSQL og FHIR-testdobbelen:

```bash
npm run fhir:test &           # FHIR-server på http://127.0.0.1:8080/fhir
npm run migrer && npm run seed
npm run dev
```

## Dokumentasjon

| Dokument | Innhold |
| --- | --- |
| [Kravdokument](docs/kravdokument.md) | Funksjonelle og ikke-funksjonelle krav, med sporing til kode og test |
| [Arkitektur](docs/arkitektur.md) | Komponenter, dataflyt og hvorfor grensene går der de går |
| [Sikkerhet og personvern](docs/sikkerhet.md) | Tilgangsmodell, trusselvurdering og forholdet til Normen |
| [Samsvar med EPJ-standarden](docs/epj-standard.md) | Tilgangsstyring, retting, sletting og sperring |
| [API](docs/api.md) | FHIR R5-endepunktet, OAuth 2.1, scopes og feilhåndtering |
| [SMART on FHIR](docs/smart-on-fhir.md) | Hvordan en app kobles til, med fullstendig eksempel |
| [Integrasjoner](docs/integrasjoner.md) | SFM, NHN meldingstjener og Helfo |
| [Installasjon med Docker](docs/installasjon-docker.md) | Én maskin, tre containere, herding før produksjon |
| [Installasjon i Kubernetes](docs/installasjon-kubernetes.md) | Manifester, nettverkspolicyer og flere virksomheter |
| [Drift](docs/drift.md) | Oppsett, konfigurasjon, nøkkelrotasjon og sikkerhetskopi |
| [Testing](docs/testing.md) | Teststrategi og hvordan testene kjøres |
| [Åpne punkter](docs/apne-punkter.md) | Det som må avklares eller verifiseres før produksjon |
| [Veikart og oppgaveliste](docs/todo.md) | Det som ikke er bygget ennå, og hva det vil kreve |

## Arkitektur i korte trekk

```
                      ┌───────────────────────────────┐
   Nettleser ────────▶│  SvelteKit                    │
   SMART-app ────────▶│  · journalgrensesnitt         │
   Backend-tjeneste ─▶│  · OAuth 2.1-server           │
                      │  · /fhir-fasade  ◀── vokteren │
                      └───────┬───────────────┬───────┘
                              │               │
                     ┌────────▼──────┐  ┌─────▼─────────┐
                     │ HAPI FHIR R5  │  │ PostgreSQL    │
                     │ kliniske data │  │ skjema «epj»  │
                     └───────┬───────┘  │ identitet,    │
                             │          │ tilgang, logg │
                     ┌───────▼───────┐  └───────────────┘
                     │ PostgreSQL    │
                     │ HAPI-skjema   │
                     └───────────────┘
```

HAPI FHIR eier de kliniske dataene. Alt utenfra går gjennom `/fhir`-fasaden,
som håndhever scope, rolle, tjenstlig behov og sperring, og skriver
sikkerhetslogg for hvert kall — også de som avvises. HAPI eksponeres aldri
direkte.

## Datautveksling

* **FHIR er JSON.** Hele API-et bruker `application/fhir+json`. XML brukes bare
  der de nasjonale meldingsstandardene krever det, altså i hodemelding,
  dialogmelding, henvisning, epikrise og applikasjonskvittering over
  Helsenettet. Innkommende meldinger speiles som FHIR-ressurser, slik at de er
  tilgjengelige som JSON på samme API som resten av journalen.
* Søk gjøres med `POST [type]/_search`, slik at fødselsnummer ikke havner i
  URL-er og mellomliggende tilgangslogger.
* **Utlevering av journal** gir det samme innholdet i to former: et FHIR-dokument
  (`Bundle` av typen `document`) for overføring til et annet journalsystem, og en
  lesbar utskrift i HTML eller ren tekst for pasienten selv. Hjemmelen velges i
  skjemaet og havner som `purposeOfUse` i sikkerhetsloggen.

## Ingen runtime-avhengigheter utover PostgreSQL-driveren

Applikasjonen bruker bare `pg` i drift. JWS, TOTP, kryptering, XML-bygging og
-parsing er implementert direkte mot Node sitt standardbibliotek. I et system
som behandler helseopplysninger er hver avhengighet også en forsyningskjederisiko.

## Kommandoer

```bash
npm run dev          # utviklingsserver
npm run build        # produksjonsbygg (adapter-node)
npm run check        # typekontroll av kode og komponenter
npm run migrer       # kjør databasemigrasjoner
npm run seed         # legg inn demodata
npm test             # enhets- og integrasjonstester (krever PostgreSQL)
npm run test:e2e     # ende-til-ende-tester (Playwright)
npm run test:alle    # begge deler
```

## Lisens og bruk

Dette er en referanseimplementasjon. Før klinisk bruk må virksomheten blant
annet gjennomføre risikovurdering og personvernkonsekvensvurdering, inngå
databehandleravtaler, og få integrasjonene mot SFM, NHN og Helfo godkjent av de
respektive partene. Se [docs/apne-punkter.md](docs/apne-punkter.md).
