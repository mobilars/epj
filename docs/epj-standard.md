# Samsvar med EPJ-standarden

EPJ-standarden *Tilgangsstyring, retting og sletting* stiller krav til hvordan
et journalsystem gir tilgang, hvordan opplysninger rettes, og hvordan de
slettes eller sperres. Dokumentet her viser hvordan kravene er løst, og hvor.

> Kravnumrene i standarden er ikke gjengitt, siden dokumentet ikke har vært
> tilgjengelig under utviklingen. Sammenstillingen følger temainndelingen.
> Før en formell samsvarserklæring må hvert punkt kontrolleres mot
> standardteksten — se [åpne punkter](apne-punkter.md).

## Tilgangsstyring

| Krav i standarden | Hvordan det er løst |
| --- | --- |
| Tilgang skal bygge på definerte roller | Elleve roller med rettigheter og maksimale scope, `authz/roles.ts` |
| Tilgang skal forutsette tjenstlig behov | Behandlingsrelasjon i `care_relationship`, håndhevet i `authz/tilgang.ts` |
| Tilgang skal kunne tidsavgrenses | Relasjoner har gyldighetsperiode; utløpte relasjoner gir ikke tilgang |
| Autorisasjonsregisteret skal kunne vedlikeholdes | Administrasjon → Brukere og roller; alle endringer loggføres |
| Tilgang skal kunne trekkes tilbake umiddelbart | Deaktivering avslutter sesjoner og trekker tilbake alle tokens |
| Uautorisert tilgang skal hindres, ikke bare skjules | Avgrensningen legges inn i FHIR-spørringen; pasienten finnes ikke i svaret |
| Alle oppslag skal registreres | `AuditEvent` for hvert kall, også avviste |

## Nødrett

| Krav | Hvordan det er løst |
| --- | --- |
| Nødrett skal være mulig | Egen flyt i journalen, tilgjengelig for kliniske roller |
| Nødrett skal kreve begrunnelse | Minst 15 tegn, kontrollert i nettleseren og på serveren |
| Nødrett skal bekreftes av brukeren | Ny engangskode (step-up-autentisering) |
| Nødrett skal være tidsbegrenset | Fire timer, kan avsluttes manuelt |
| Nødrett skal være synlig for brukeren | Rødt pasientbanner og eget varsel gjennom hele økten |
| Nødrett skal kunne følges opp | `purposeOfUse = ETREAT`; gjennomgangskø på administrasjonssiden |
| Pasienten skal kunne informeres | Nødrettsoppslag er merket i pasientens innsynslogg |

## Retting

| Krav | Hvordan det er løst |
| --- | --- |
| Retting skal ikke fjerne det opprinnelige | Ny versjon; HAPI beholder forrige |
| Rettingen skal kunne spores | `[type]/[id]/_history`, forfatter merket på ressursen |
| Feilført innhold skal merkes | `entered-in-error` med begrunnelse, innholdet består |
| Den som retter skal identifiseres | `meta.tag` med forfatter, og `AuditEvent` |

## Sletting

| Krav | Hvordan det er løst |
| --- | --- |
| Sletting skal ikke være en ordinær journalfunksjon | Endelig sletting er ikke eksponert i grensesnittet |
| Sletting skal kreve vedtak | Funksjonen finnes i koden, men uten vedtaksflyt — se åpne punkter |
| Sletting av søkbarhet skal skilles fra endelig sletting | `DELETE` fjerner fra søk; versjonene beholdes |
| Sletting skal loggføres | `AuditEvent` med handling `D` |

## Sperring

| Krav | Hvordan det er løst |
| --- | --- |
| Pasienten skal kunne sperre journalen | Sperring mot bruker, rolle, alle, eller enkeltdokument |
| Sperring skal håndheves ved oppslag | `erSperret()` i tilgangsbeslutningen |
| Sperring skal håndheves ved søk | `sperredePasienter()` filtrerer også søkeresultater |
| Sperring skal kunne oppheves | Egen markering; historikken beholdes |
| Nødrett skal kunne overstyre sperring | Ja, og oppslaget merkes særskilt |

## Logging og innsyn

| Krav | Hvordan det er løst |
| --- | --- |
| Loggen skal inneholde hvem, hva, når og hvilken pasient | FHIR `AuditEvent` med aktør, handling, tidspunkt, pasient, app og adresse |
| Loggen skal ikke kunne endres | Databasetrigger avviser `UPDATE`/`DELETE`; radene er hash-lenket |
| Pasienten skal kunne få innsyn i loggen | Innsynslogg per pasient |
| Loggen skal kunne gjennomgås | Filtrering på pasient, bruker, type og nødrett |
| Loggen skal bevares | Konfigurerbar oppbevaringstid, ti år som utgangspunkt |

## Dokumentasjon av helsehjelp

| Krav | Hvordan det er løst |
| --- | --- |
| Journalen skal føres fortløpende | Notat knyttet til `Encounter`, med tidsstempel og forfatter |
| Journalen skal ha struktur | `Composition` med subjektivt, objektivt, vurdering og plan |
| Diagnoser skal kodes | ICPC-2 ved kontakt, ICD-10 støttes i meldinger |
| Legemidler skal være samstemt | Pasientens legemiddelliste fra SFM, med avviksmarkering |
| Kritisk informasjon skal være synlig | Allergier og intoleranser øverst i oversiktsbildet |

## Meldingsutveksling

| Krav | Hvordan det er løst |
| --- | --- |
| Meldinger skal følge nasjonale standarder | Hodemelding (MsgHead) med fagmelding, over Helsenettet |
| Mottaker skal slås opp i Adresseregisteret | Kontroll av HER-id og støttet meldingstype før sending |
| Mottak skal kvitteres | Applikasjonskvittering (AppRec) med status og feilkoder |
| Sending skal følges opp | Meldinger uten kvittering listes som eget arbeidsområde |
| Meldinger skal inn i journalen | Speiles som `Communication`, `DocumentReference` eller `ServiceRequest` |
