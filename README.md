# EPJ — en åpen plattform for journalapper

**Plattformen er rammen. Appene er journalen.** Plattformen eier det alle apper
trenger: innlogging, tilgang, pasientkontekst, menyer, appstyring og sikkerhetslogg.
Det klinikeren faktisk jobber med, som notater, legemidler og meldinger, skal være
apper oppå den. En virksomhet skal kunne bytte ut en app uten at vi slipper en ny
versjon av plattformen, og andre leverandører skal kunne lage apper på like vilkår.

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

Plattformen er åpen gjennom standarder: **SMART on FHIR** for apper, **CDS Hooks**
for beslutningsstøtte og **FHIR R5** for data. Den er laget for norske legekontor,
med **HelseID** og norske tilgangsregler, og én installasjon kan betjene flere
legekontorer med hver sine data, brukere, logg og nøkler.

## Hvor langt vi har kommet

Dette er målbildet, ikke dagens kode. I dag ligger mye funksjonalitet fortsatt inne i
plattformen. Se [veien dit](docs/arkitektur.md#plattform-og-apper).

| | I dag |
| --- | --- |
| **Plattformen** | Bygget: pålogging, roller, FHIR med vokteren, appkatalog, sikkerhetslogg |
| **SMART-apper** | Virker, også fra andre leverandører. Fire demonstrasjonsapper følger med (`deploy/apus/demo-app/`) |
| **Innebygde funksjoner** | Notater, legemidler, meldinger og oppgjør ligger i selve plattformen. De skal skilles ut |
| **SFM, NHN, Helfo** | Ikke koblet til. Alt kjører mot lokale simulatorer. SFM er bygget, men avslått: se [docs/sfm.md](docs/sfm.md) |
| **Klinisk bruk** | Ikke klart. Se [åpne punkter](docs/apne-punkter.md) |

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
| [Arkitektur](docs/arkitektur.md) | Plattform og apper, komponenter, dataflyt og hvorfor grensene går der de går |
| [Sikkerhet og personvern](docs/sikkerhet.md) | Tilgangsmodell, trusselvurdering og forholdet til Normen |
| [Samsvar med EPJ-standarden](docs/epj-standard.md) | Tilgangsstyring, retting, sletting og sperring |
| [API](docs/api.md) | FHIR R5-endepunktet, OAuth 2.1, scopes og feilhåndtering |
| [SMART on FHIR](docs/smart-on-fhir.md) | Hvordan en app kobles til, med fullstendig eksempel |
| [Integrasjoner](docs/integrasjoner.md) | SFM, NHN meldingstjener og Helfo |
| [SFM](docs/sfm.md) | Koblingen til Sentral forskrivningsmodul: status og krav |
| [Installasjon med Docker](docs/installasjon-docker.md) | Én maskin, tre containere, herding før produksjon |
| [Installasjon i Kubernetes](docs/installasjon-kubernetes.md) | Manifester, nettverkspolicyer og flere virksomheter |
| [Drift](docs/drift.md) | Oppsett, konfigurasjon, nøkkelrotasjon og sikkerhetskopi |
| [Testing](docs/testing.md) | Teststrategi og hvordan testene kjøres |
| [Åpne punkter](docs/apne-punkter.md) | Det som må avklares eller verifiseres før produksjon |
| [Veikart og oppgaveliste](docs/todo.md) | Det som ikke er bygget ennå, og hva det vil kreve |

## Sikkerhetsprinsippet

HAPI FHIR eier de kliniske dataene og eksponeres aldri direkte. Alt går gjennom
`/fhir`-fasaden, *vokteren*, som håndhever scope, rolle, tjenstlig behov og sperring,
og skriver sikkerhetslogg for hvert kall, også de som avvises. Det gjelder appene, og
det gjelder plattformens egne sider. Se [arkitektur](docs/arkitektur.md).

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

## Få avhengigheter

Applikasjonen har tre avhengigheter i drift: `pg`, `jose` og `openid-client`. TOTP,
kryptering og XML er skrevet direkte mot Node sitt standardbibliotek. I et system som
behandler helseopplysninger er hver avhengighet også en forsyningskjederisiko.

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

## Før klinisk bruk

Systemet er ikke satt i klinisk drift. Før det kan skje, må virksomheten blant
annet gjennomføre risikovurdering og personvernkonsekvensvurdering, inngå
databehandleravtaler, og få integrasjonene mot SFM, NHN og Helfo godkjent av de
respektive partene. Se [docs/apne-punkter.md](docs/apne-punkter.md).

## Lisens

Copyright © 2026 APUS Roland AS.

Dette programmet er fri programvare: du kan distribuere det videre og/eller
endre det under vilkårene i **GNU Affero General Public License** slik den er
publisert av Free Software Foundation, enten versjon 3 av lisensen eller (etter
eget valg) en senere versjon.

Programmet distribueres i håp om at det er nyttig, men **uten noen garanti** —
uten engang den underforståtte garantien om salgbarhet eller egnethet for et
bestemt formål. Se GNU Affero General Public License for detaljer. Lisensteksten
ligger i [LICENSE](LICENSE).

AGPL § 13 gjelder særskilt for journalsystemer som dette: **kjører du en endret
utgave som andre bruker over nett, må du tilby dem kildekoden til din utgave.**
Det holder ikke å la være å distribuere programmet.
