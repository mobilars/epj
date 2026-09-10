# Integrasjoner

Tre nasjonale integrasjoner: **SFM** for legemidler, **NHN meldingstjener** for
helsemeldinger, og **Helfo** for refusjon. Alle tre kan kjøres i to modus:

* `EPJ_INTEGRATION_MODE=mock` — lokale simulatorer. Hele flyten kan øves og
  testes uten oppkobling mot Helsenettet.
* `EPJ_INTEGRATION_MODE=live` — ekte endepunkter. Krever avtaler, tilgang og
  som regel klientsertifikat.

---

## Sentral forskrivningsmodul (SFM)

SFM driftes av Norsk helsenett og er veien til e-resept og Pasientens
legemiddelliste. EPJ-leverandører kan enten bruke SFM sitt eget grensesnitt
eller integrere mot API-et. Denne journalen bruker API-varianten: forskrivning
skjer i journalens eget bilde, og SFM håndterer Reseptformidleren.

### Operasjoner

| Operasjon | Bruk |
| --- | --- |
| `hentLegemiddelliste` | Pasientens legemiddelliste, med avvik som må avstemmes |
| `forskriv` | Ny resept; gir reseptid og eventuelle varsler |
| `fornye` | Fornyer en eksisterende resept |
| `seponer` | Seponerer med årsak |
| `tilbakekall` | Tilbakekaller en resept |
| `hentUtleveringer` | Utleveringer rapportert fra apotek |

### Autentisering

HelseID-maskintoken: `client_credentials` med `private_key_jwt`. Tokenet caches
til like før utløp. Ingen delt hemmelighet ligger i konfigurasjonen.

### Speiling til FHIR

Hver resept lagres også som `MedicationRequest` med ATC-kode, varenummer,
dosering, gyldighetsperiode og eventuell refusjonshjemmel. Da er reseptene
søkbare på `/fhir` og synlige for SMART-apper.

### Varsler

Simulatoren gjengir interaksjons- og dobbeltforskrivningsvarsler, slik at flyten
kan testes:

```
ALVORLIG: Warfarin og ibuprofen: økt blødningsrisiko.
DOBBELTFORSKRIVNING: pasienten har allerede en aktiv resept med samme virkestoff.
```

Interaksjonsutvalget er lite og finnes for å vise flyten. Produksjon krever en
klinisk vedlikeholdt kilde — se [åpne punkter](apne-punkter.md).

### Konfigurasjon

```bash
EPJ_SFM_BASE_URL=https://sfm.test.nhn.no/api
EPJ_SFM_SCOPE=nhn:sfm/api
EPJ_HELSEID_CLIENT_ID=…
EPJ_HELSEID_PRIVATE_KEY=…
```

Tilgang til SFM testmiljø bestilles hos Norsk helsenett.

---

## NHN meldingstjener

All meldingsutveksling av helseopplysninger går over Helsenettet. Meldingene er
XML: en **hodemelding (MsgHead)** som identifiserer avsender, mottaker, pasient
og meldingstype, med fagmeldingen som innhold.

### Meldingstyper

| Type | Retning | Bruk |
| --- | --- | --- |
| `HENVIS` | ut | Henvisning til spesialisthelsetjenesten |
| `EPIKRISE` | inn | Epikrise etter sykehusopphold |
| `DIALOG_HELSEFAGLIG` | begge | Helsefaglig dialog |
| `DIALOG_FORESPORSEL` / `DIALOG_SVAR` | begge | Forespørsel og svar |
| `DIALOG_NOTAT` | begge | Notat |
| `MEDLAB` | ut | Laboratorierekvisisjon |
| `SVAR_LAB` | inn | Prøvesvar |
| `APPREC` | begge | Applikasjonskvittering |

### Adresseregisteret

Før sending slås mottakeren opp: finnes HER-id-en, er den aktiv, og støtter
mottakeren meldingstypen? En melding til en mottaker som ikke kan ta imot den
legges ikke i kø. Dette er en av de vanligste feilkildene i
meldingsutvekslingen, og den er billigst å fange her.

### Utgående kø

Meldinger legges i kø og sendes av en jobb med eksponentiell tilbaketrekking
(1, 2, 4, 8, 16, 32 minutter, maksimalt seks forsøk). En rådgivende lås i
databasen hindrer at flere appinstanser sender samme melding.

**En melding er ikke levert før den er kvittert.** Statusen går
`kø → sendt → kvittert`, og sendte meldinger uten kvittering etter en time
vises som eget arbeidsområde.

### Innkommende meldinger

```
melding mottas
  ├── les hodemelding
  ├── er dette et duplikat?         → AppRec status 2, feilkode S02
  ├── finn pasient på fødselsnummer → ukjent gir AppRec status 2, feilkode E30
  ├── lagre og speil som FHIR-ressurs
  └── send AppRec tilbake
```

Speiling: epikrise og prøvesvar blir `DocumentReference`, henvisning blir
`ServiceRequest`, dialogmeldinger blir `Communication`. Originalen beholdes som
vedlegg, slik at ingenting går tapt i konverteringen.

### Applikasjonskvittering

| Status | Betydning |
| --- | --- |
| `1` | Mottatt og lest inn |
| `2` | Mottatt med merknad, for eksempel ukjent pasient |
| `3` | Avvist, for eksempel fordi meldingen ikke lar seg lese |

### Konfigurasjon

```bash
EPJ_NHN_MESSAGE_SERVER_URL=https://meldingstjener.test.nhn.no
EPJ_NHN_ADDRESSREGISTRY_URL=https://adresseregisteret.test.nhn.no
EPJ_ORG_HER_ID=8000001
EPJ_ORG_NUMBER=999999999
```

---

## Helfo

### Frikort og egenandel

Før egenandel kreves inn, slås frikortstatus opp hos Helfo. Har pasienten
frikort, dekker Helfo egenandelen. Svaret mellomlagres i én time; hvert oppslag
loggføres med formål `HPAYMT`, siden det er en behandling av personopplysninger.

### Takster og regningskort

Takstregisteret bygger på Normaltariff for privat allmennpraksis, og
kontrollerer ved registrering:

* takster som ikke kan kombineres (`2ad` og `1ak`),
* takster som krever grunntakst (`2cd` uten konsultasjon),
* maksimalt antall ved repeterbare takster,
* takster som krever spesialist i allmennmedisin.

Regelbrudd stoppes med en gang, ikke først i Helfos avregning seks uker senere.

**Beløpene er et arbeidsgrunnlag.** Normaltariffen forhandles årlig og trer i
kraft 1. juli. Alle takster er merket `verifisert: false` og må oppdateres fra
gjeldende tariff — se [åpne punkter](apne-punkter.md).

### Fritak for egenandel

Barn under 16 år, godkjent yrkesskade, svangerskapskontroll, allmennfarlig
smittsom sykdom, militærtjeneste og gyldig frikort. Fritaket fjerner
egenandelen, men ikke refusjonen fra Helfo.

### Oppgjør

```
regningskort (status «klar»)
   └── forhåndsvisning for perioden, med advarsel om manglende diagnosekode
        └── generer oppgjør → kortene får status «sendt»
             └── send til Helfo → kvittering med referanse
                  └── registrer avregning → godkjent eller avvist med årsak
```

Avviste kort vises som eget arbeidsområde, slik at de kan rettes og sendes på
nytt.

### Speiling til FHIR

Hvert regningskort lagres også som `Claim` med diagnose, takstlinjer og beløp,
slik at oppgjørsdata er tilgjengelige på samme API som resten av journalen.

### Konfigurasjon

```bash
EPJ_HELFO_SETTLEMENT_URL=https://oppgjor.test.helfo.no
EPJ_HELFO_COPAYMENT_URL=https://egenandel.test.helfo.no
EPJ_HELFO_AGREEMENT_ID=…
```

Avtale om direkte oppgjør inngås med Helfo.

---

## Å teste uten Helsenettet

I `mock`-modus:

* **SFM** simulerer forskrivning, legemiddelliste, seponering, fornying og
  varsler, med tilstand i databasen slik at den overlever omstart.
* **Meldingstjeneren** leverer lokalt og kvitterer automatisk, slik at hele
  kjeden fra sending til kvittering kan følges.
* **Adresseregisteret** har et lite testregister med realistiske
  kommunikasjonsparter og hvilke meldingstyper de støtter.
* **Helfo** gir deterministisk frikortstatus utledet fra siste siffer i
  fødselsnummeret, slik at testdata gir forutsigbare resultater.
