# CDS Hooks i journalen

Journalen er begge sider av CDS Hooks: den spør tjenester en virksomhet har
registrert, og den tilbyr tjenester selv. Dette dokumentet beskriver hva som
sendes, hva som kreves, og hva et kort får lov til.

Standarden: <https://cds-hooks.hl7.org/> (2.0).

## Krokene journalen fyrer

| Krok                   | Når                                            | `context`                                         |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `patient-view`         | Pasientens forside åpnes                       | `userId`, `patientId`                             |
| `medication-prescribe` | En resept er skrevet, men ikke sendt           | `userId`, `patientId`, `medications`, `draftOrders` |
| `order-sign`           | Resepten er signert og sendt til e-resept      | `userId`, `patientId`, `draftOrders`              |

`fhirServer` er alltid virksomhetens FHIR-endepunkt. Journalen sender
**ingen pasientdata** i forespørselen utover det som står i `context` — for
`patient-view` bare pasientens id. En tjeneste som vil vite mer, henter det
selv med et token den har fått gjennom SMART Backend Services, og oppslaget
loggføres på tjenesten som på enhver annen. Det holder innsynsloggen ærlig.

Ved `medication-prescribe` sendes utkastet til `MedicationRequest` i
`draftOrders` (og i `medications`, for tjenester skrevet mot 1.0), siden
tjenesten ellers ikke kan vite hva som er i ferd med å bli forskrevet.

## Signerte forespørsler

Hvert kall bærer et JWT i `Authorization: Bearer …`, signert med
virksomhetens nøkkel — den samme som signerer access tokens:

```json
{
  "iss": "https://epj.example.no",
  "sub": "https://epj.example.no",
  "aud": "https://tjeneste.example",
  "jti": "…",
  "iat": 1789680000,
  "exp": 1789680300,
  "tenant": "standard"
}
```

Headeren har `kid`. Tjenesten henter nøklene fra `<iss>/oauth/jwks` og
verifiserer. `aud` er tjenestens base-URL — den samme for oppdagelsen og for
alle tjenester under den — så et token for én tjeneste ikke kan spilles av mot
en annen. Levetiden er fem minutter.

Journalens egne tjenester **krever** dette. Uten det svarte de hvem som helst
som fant adressen med hva journalen vet om pasient-id-en de sendte inn.

## Kort

Et kort sier noe. Det kan ikke skrive i journalen, ikke endre det som vises,
og ikke stoppe noen. Behandleren avgjør; tjenesten får si sitt.

```json
{
  "cards": [
    {
      "uuid": "…",
      "summary": "eGFR 52 ml/min/1,73 m² (G3a, lett til moderat nedsatt)",
      "detail": "CKD-EPI 2021 fra kreatinin 118 µmol/L målt 03.09.2026, alder 71 år, mann.",
      "indicator": "warning",
      "source": { "label": "Storgata Legesenter · kalkulatorer" },
      "selectionBehavior": "at-most-one",
      "suggestions": [
        {
          "label": "Registrer «nedsatt nyrefunksjon G3a» som problem",
          "uuid": "…",
          "actions": [{ "type": "create", "resource": { "resourceType": "Condition", "…": "…" } }]
        }
      ]
    }
  ]
}
```

`uuid` på kortet er det tilbakemeldingen peker på. Sett det.

### Forslag

Et forslag er et råd med en form: ressurser tjenesten foreslår at journalen
oppretter. Behandleren ser dem som knapper på pasientens forside og trykker
på én eller ingen. Trykket er **behandlerens skriving**, gjennom samme dør som
alle andre, vurdert etter scope, rolle og behandlingsrelasjon. Tjenesten
skriver aldri.

Det som slipper gjennom:

- bare `create`. `update` og `delete` avvises — et forslag kan legge til, ikke
  endre eller fjerne.
- bare ressurser om pasienten kortet gjaldt. `subject`/`patient` må peke på
  den pasienten.
- ingen `id` på ressursen. En `create` med id er en oppdatering med hatt på.

Et forslag der noe avvises, utfører det som er lov og sier hva som ble hoppet
over. Alt loggføres som `cds / forslag:godtatt` med hva som ble opprettet.

### Tilbakemelding

Journalen sender tilbakemelding etter 2.0 til
`<tjeneste>/cds-services/<id>/feedback` når et forslag utføres (`accepted`,
med `acceptedSuggestions`) og når et kort settes til side (`overridden`, med
`overrideReason` hvis kortet oppga grunner). Beste forsøk: en tjeneste uten
feedback-endepunkt gjør ikke et trykk til en feil.

## Journalens egne tjenester

Oppdagelse: `<utsteder>/cds-services`. De kan registreres i journalen som
enhver annen tjeneste — og det er slik de brukes. Journalen kaller dem over
nettet, signert, som en demonstrasjon av protokollen snarere enn en snarvei.

| Tjeneste              | Krok                   | Gjør                                                                                     |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `kritisk-informasjon` | `patient-view`         | Alvorlige allergier og tilstander fra journalen selv                                     |
| `manglende-maalinger` | `patient-view`         | Målinger som mangler siste året. Foreslår rekvisisjon (`ServiceRequest`) der det passer |
| `kalkulatorer`        | `patient-view`         | eGFR (CKD-EPI 2021) og BMI fra siste målinger, med kilde og dato. Foreslår problem ved eGFR < 60 |
| `interaksjonssjekk`   | `medication-prescribe` | Kjente interaksjoner og allergier. **Demonstrasjon** — tre oppføringer, ikke en kilde   |

Alle fire tar imot tilbakemelding på `/feedback` og skriver den til
sikkerhetsloggen.

`interaksjonssjekk` er merket som demonstrasjon av en grunn: et råd som ser
autoritativt ut uten å være det, er verre enn ingen råd, fordi tausheten blir
lest som en bekreftelse. En ekte kilde er FEST. Se todo.md.

## Å skrive en tjeneste

1. Svar på `GET /cds-services` med tjenestene dine, hver med `hook`, `id`,
   `title`, `description`.
2. Verifiser `Authorization` mot `<iss>/oauth/jwks`. Avvis alt annet.
3. Svar på `POST /cds-services/<id>` med `{ cards: [...] }`. Sett `uuid` på
   hvert kort. Svar innen tre sekunder — journalen venter ikke lenger.
4. Vil du vite mer om pasienten: bruk SMART Backend Services mot
   `fhirServer` med egne nøkler. Det loggføres.
5. Foreslå heller enn å beskrive, der det finnes en ressurs å opprette. En
   `ServiceRequest` er ett trykk for behandleren; «husk å rekvirere» er en
   lapp.
6. Ta imot `POST /cds-services/<id>/feedback`, og lær av det.

Registrer tjenesten under Administrasjon → Beslutningsstøtte. Journalen leser
oppdagelsen og kaller det den finner.
