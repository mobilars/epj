# Sentral forskrivningsmodul (SFM)

SFM er Norsk helsenetts nasjonale legemiddelmodul og veien til e-resept,
Reseptformidleren og Pasientens legemiddelliste. Dette dokumentet beskriver
hvordan journalen kobles til, hva som er bygget, og hva som gjenstår.

**Status oktober 2026:** Koblingen er bygget, men avslått som standard
(`EPJ_SFM_FULL=false`). Den er testet mot en lokal simulator, ikke mot NHN.
Journalens eget forskrivningsskjema snakker bare med en simulator og når aldri
NHN. Forespørsel om tilgang er sendt til NHN.

## Valget: SFM Full, ikke SFM Basis

| | SFM Full | SFM Basis |
| --- | --- | --- |
| Skjermbildet | SFMs eget, i en ramme i journalen | Vi bygger hele legemiddelmodulen selv |
| Målgruppe | EPJ-leverandører generelt | «dedicated for major vendors» |
| Godkjenning | NHNs godkjenningsprosess med akseptansetest | E-resept-verdikjeden |
| Pasientbillett | Ja | Nei |

Med SFM Full forskrives det i SFMs skjermbilde. Journalens forskrivningsskjema
og `medication-prescribe`-kroken er dermed ikke i bruk når SFM er slått på.

## Ikke en SMART-app

Koblingen er en del av plattformen, ikke en SMART-app. Tokenet SFM krever, kommer
fra legens HelseID-pålogging i journalen, og det skal ikke forlate tjeneren. En
SMART-app får journalens eget token, ikke HelseIDs, og måtte derfor logget inn i
HelseID selv, med egen klient og egen godkjenning hos NHN. Den innloggingen lar
seg ikke vise i en ramme, samme problem som med Spirare. Appen måtte også fått
fødselsnummeret for å hente billetten.

Skillet som finnes: SFMs skjermbilde kjører fra NHNs eget domene og får bare en
billett, og koden ligger samlet under `integrations/sfm/`.

**Merk:** En app registrert med `replacesTab: 'legemidler'` overtar fanen. Da
vises appen og ikke SFM, også når `EPJ_SFM_FULL` er på. Demo-appen Legemidler er
satt opp slik i `scripts/register-demo-app.ts`, så dette må fjernes før SFM slås på.

## Slik virker det

1. Legen logger inn med HelseID. Tokenet har også SFM-scopet, og beholdes kryptert
   på tjeneren så lenge økten varer.
2. Legemidler-fanen ber journalens tjener om å starte SFM for pasienten.
3. Tjeneren leser pasienten gjennom vokteren som brukeren, og oppretter en
   SFM-økt med en hash av en engangsverdi.
4. Tjeneren veksler fødselsnummeret mot en pasientbillett.
5. Siden laster SFMs pasientportal i en ramme, og sender innlogging og billett med
   `postMessage`.

Fødselsnummeret går aldri til nettleseren eller inn i rammen. Pasientbanneret
utenfor rammen viser hvem journalen gjelder, slik NHN krever.

Tre ting er strengere enn NHNs eksempelkode:

- Meldinger sendes bare til portalens eget opphav, ikke til `*`, fordi
  innloggingsmeldingen bærer engangskoden.
- Bare meldinger fra selve rammen og fra portalens opphav blir lest.
- En pasient med *ikke gyldig* fødselsnummer åpnes ikke i SFM, fordi nummeret ville
  gått videre til Reseptformidleren som om det var ekte.

## Kode

| Hva | Hvor |
| --- | --- |
| Sesjonsgateway, engangsverdi, billett | `src/lib/server/integrations/sfm/session-gateway.ts` |
| Kryptert lagring og fornying av token | `src/lib/server/integrations/sfm/tokens.ts` |
| `authorization_details` for multi-tenant | `src/lib/server/integrations/sfm/authorization.ts` |
| Meldingsutvekslingen med rammen | `src/lib/sfm/handshake.ts` |
| Rammen | `src/lib/components/SfmFrame.svelte` |
| Start for én pasient | `src/routes/pasienter/[id]/legemidler/sfm-sesjon/` |
| Holder økten i live | `src/routes/sfm/oppfrisk/` |
| Lokal simulator av portalen | `src/routes/sfm-simulator/` |
| Lagring | migrasjon `021_sfm_session.sql` |

Hvert oppslag loggføres som `sfm:åpne`. Når brukeren logger ut, avsluttes
SFM-økten og tokenet slettes.

## Konfigurasjon

```bash
EPJ_SFM_FULL=true
EPJ_SFM_SESSION_URL=https://session.test6.forskrivning.no
EPJ_SFM_SCOPE=e-helse:sfm.api/sfm.api2
EPJ_ALLOW_SYNTHETIC_IDS=true   # bare testinstallasjoner
```

**Slå ikke på `EPJ_SFM_FULL` før HelseID-klienten har fått SFM-scopet.** Scopet
legges til i innloggingen, så en klient uten det får alle innlogginger avvist.

Med `EPJ_INTEGRATION_MODE=mock` kjører alt mot simulatoren, uten HelseID-token.

Journal-id og overordnet organisasjonsnummer settes per virksomhet under
*Plattformadministrasjon*. Står journal-id tom, sendes ingen
`authorization_details`. Det er riktig for en single-tenant-klient.

### Syntetiske fødselsnummer

SyntPop, som NHNs testmiljøer bruker, legger 65 eller 80 til måneden. Journalen
godtar disse bare med `EPJ_ALLOW_SYNTHETIC_IDS=true`. Uten verdien er de avslått
når `NODE_ENV=production`. En klinisk installasjon skal ha dem avslått.

## Test

```bash
npm test                                         # regler, meldinger, tall
EPJ_TEST_DATABASE_URL=postgres://… npm test      # også tokenlagring
EPJ_SFM_FULL=true npx playwright test e2e/sfm.spec.ts   # hele flyten mot simulatoren
```

## Dette er ikke bevist ennå

Alt under krever tilgang hos NHN:

1. **Tredjepartskaker.** NHN beskriver SFM-økten som en kobling mellom token og
   kake. I vår ramme er det en tredjepartskake, samme problem som med Spirare.
   Dette er den største tekniske risikoen. Test den først, med `microepj.html` fra
   `NorskHelsenett/SFM.tools/browser`.
2. **Om portalen lar seg ramme inn** fra vårt vertsnavn.
3. **Requestobjektet** med `authorization_details`. Det er skrevet etter NHNs
   eksempel, men aldri sendt til HelseID.
4. **Fornying av tokenet** med `refreshTokenGrant` og DPoP.
5. **v2-stiene.** NHNs sekvensdiagrammer viser `/api/Session/create`, mens
   eksempelkoden bruker `/api/v2/Session/create`. Vi følger eksempelkoden.

## Gjenstår

| Hva | Hvorfor det venter |
| --- | --- |
| Hente legemiddellisten til journalen (`List?patientTicket=`) | Svaret må sees for å kartlegges; SFM svarer FHIR R4, journalen lagrer R5 |
| SFM-oppgaver i en arbeidsliste | **Krav fra NHN.** Parametrene står ikke i dokumentasjonen vi har lest |
| Signerte journalnotater inn i journalen | Hentes etter signert LIB; se Simplifier-veiledningen |
| Sende diagnoser og målinger (`Condition`, `Observation`) | Som over |
| CDS Hooks for forskrivning | Kroken kan ikke fyre inne i SFMs ramme, så dette må tenkes nytt |
| Persontjenesten | **Krav fra NHN**, ikke bygget |
| Multi-tenant-godkjenning hos HelseID | Krever kodegjennomgang hos NHN |

## Forutsetninger hos NHN

- Signerte leverandørvilkår, og medlemskap i Helsenettet. Tilbys SFM uten
  Helsenett-tilkobling hos kunden, kreves egen godkjenning.
- HelseID med godkjent kodegjennomgang, støtte for Persontjenesten og
  FHIR-kompetanse.
- HelseID-klient med SFM som konsumert API. Multi-tenant: leverandøren
  forhåndsregistreres i SFM, og virksomheten delegerer rettigheter i Altinn.
- Hver virksomhet må være registrert i Adresseregisteret med HER-id, i
  Reseptformidleren og i Kjernejournal, og opprettes som instans i SFM.
- Godkjent akseptansetest før utprøving og innføring.

Kontakt: kundesenter@nhn.no, med emne «Oppkobling SFM testmiljø» for testtilgang og
«Godkjenningsprosess SFM Fullversjon» for godkjenning. Slack-kanalen `#ext-sfm`
kan bestilles samme sted.

## Frister

| Frist | Hva |
| --- | --- |
| Desember 2026 | Vedlegg fjernes fra LIB-listen i Datadeling-API-et |
| Januar 2027 | Søk på fødselsnummer med GET blokkeres; bruk POST |
| 11. januar 2027 | DPoP kreves mot SFMs API-er i produksjon |

Fra 2032 innfører Skatteetaten nye nummerserier og ny kontrollberegning for
fødselsnummer. Se [todo.md](todo.md).

## Testmiljø

| Miljø | Bruk | Adresser |
| --- | --- | --- |
| Test6 | SFM Full | `session.test6.forskrivning.no`, `datashare.test6.forskrivning.no`, `dataimport.test6.forskrivning.no` |
| Test5 | SFM Basis | `base-fhir.test5.forskrivning.no` |

Begge svarer fra det åpne internettet. Sjekket oktober 2026.

## Kilder

- [SFM på Utviklerportalen](https://utviklerportal.nhn.no/informasjonstjenester/sentral-forskrivningsmodul)
- [Sekvensdiagrammer for SFM-klienten](https://utviklerportal.nhn.no/informasjonstjenester/sentral-forskrivningsmodul/sfm-full-integration/integrating-with-the-sfm-client/sequence-diagrams-sfm-client)
- [Autentisering og autorisasjon](https://utviklerportal.nhn.no/informasjonstjenester/sentral-forskrivningsmodul/introduction-sfm/authentication-and-authorization)
- [For leverandører](https://www.nhn.no/tjenester/sentralforskrivningsmodul/for-leverandorer)
- [Veikart](https://www.nhn.no/tjenester/sentralforskrivningsmodul/veikart)
- [NorskHelsenett/SFM.tools](https://github.com/NorskHelsenett/SFM.tools)
- [ThulaSource/WebEPJSampleApp](https://github.com/ThulaSource/WebEPJSampleApp)
- [Om den syntetiske befolkningen](https://utviklerportal.nhn.no/informasjonstjenester/syntpop/om-den-syntetiske-befolkningen)
