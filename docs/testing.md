# Testing

Kort oppsummert: **346 enhets- og integrasjonstester** og **49
ende-til-ende-tester**. Enhetstestene kjører mot ekte PostgreSQL, ikke mot en
etterlikning. Ende-til-ende-testene kjører mot hele stakken i en ekte nettleser.

## Kjøre testene

```bash
# Enhets- og integrasjonstester (krever PostgreSQL)
EPJ_TEST_DATABASE_URL=postgres://epj@localhost:5432/postgres npm test

# Ende-til-ende (starter FHIR-server og applikasjon selv)
npm run test:e2e

# Alt
npm run test:alle
```

Integrasjonstestene oppretter en egen database per testfil og river den etterpå.
`EPJ_TEST_DATABASE_URL` skal peke på en server der testbrukeren kan opprette
databaser. Uten variabelen hoppes integrasjonstestene over, og enhetstestene
kjører alene.

I miljøer der Chromium allerede er installert utenfor Playwright:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/sti/til/chrome npm run test:e2e
```

## Hva testes hvor

| Fil | Dekker |
| --- | --- |
| `tests/kodeverk.test.ts` | Fødselsnummer, D-nummer, organisasjonsnummer, HPR, maskering |
| `tests/scopes.test.ts` | SMART-scope: parsing, kontroll, innsnevring, forklaringer |
| `tests/jws.test.ts` | ES256/RS256/PS256, `alg=none`, HS256-forvirring, utløp, unik `kid` |
| `tests/totp.test.ts` | RFC 6238-testvektorer, klokkeavvik, formatkontroll |
| `tests/crypto.test.ts` | AES-256-GCM, scrypt, konstanttidssammenlikning |
| `tests/xml-meldinger.test.ts` | Hodemelding, dialogmelding, henvisning, epikrise, AppRec |
| `tests/takster.test.ts` | Takstregler, kombinasjoner, fritak, beregning |
| `tests/fhir-validering.test.ts` | Strukturell validering, norske identifikatorer, FHIR-stier |
| `tests/audit.test.ts` | Hash-lenking, append-only, oppdagelse av tukling |
| `tests/tilgang.test.ts` | Alle fire lagene i tilgangsbeslutningen |
| `tests/gateway.test.ts` | Vokteren over ekte HTTP mot en FHIR-server |
| `tests/oauth.test.ts` | Hele OAuth- og SMART-flyten, inkludert angrepsscenarioer |
| `tests/integrasjoner.test.ts` | SFM, NHN-kø, Adresseregisteret, Helfo |
| `tests/brukere.test.ts` | Roller, pålogging, sesjoner, ratebegrensning |
| `tests/multitenancy.test.ts` | Virksomhetsregister, partisjoner og isolasjon mellom virksomheter |
| `tests/utlevering.test.ts` | Journalutskrift i FHIR-dokument og lesbart format |
| `e2e/palogging.spec.ts` | Pålogging i nettleser |
| `e2e/journal.spec.ts` | Pasientsøk, notat, feilføring, forskrivning, innsynslogg |
| `e2e/tilgang.spec.ts` | Tjenstlig behov, sperring, nødrett, rollegrenser |
| `e2e/smart.spec.ts` | Hele SMART-flyten, og hva appen ikke får |
| `e2e/oppgjor.spec.ts` | Takstvalg, regelbrudd, fritak, innsending |
| `e2e/utlevering.spec.ts` | Nedlasting av journal i begge formater, og hvem som ikke får |
| `e2e/systemadmin.spec.ts` | Opprettelse og suspensjon av virksomheter, og hvem som ikke slipper inn |

## Prinsipper

**Test mot ekte infrastruktur.** Integrasjonstestene bruker ekte PostgreSQL,
fordi det som skal testes er triggere, transaksjoner og typer. En etterlikning
ville bekreftet at koden gjør som den er skrevet, ikke at databasen gjør som vi
tror.

**Test det som ikke skal virke.** Halvparten av tilgangstestene handler om at
noe blir nektet: uten behandlingsrelasjon, ved sperring, uten scope, mot feil
pasient. Det er der en journal svikter.

**Test at serveren ikke stoler på klienten.** Nødrettstesten kontrollerer både
at nettleseren stopper en for kort begrunnelse, og at serveren gjør det samme
når nettleserkontrollen omgås.

**Bruk ekte testvektorer.** TOTP testes mot RFC 6238, PKCE mot RFC 7636, base32
mot RFC 4648. Da testes standarden, ikke bare implementasjonen mot seg selv.

**Bruk gyldige testdata.** Fødselsnumrene i demodataene er gyldige mod11-numre
som ikke tilhører noen virkelig person. Seed-skriptet avviser ugyldige numre —
en test som passerer på ugyldige data har ikke testet valideringen.

## FHIR-serveren i testene

Enhetstestene kjører mot en testdobbel (`tests/fixtures/fhir-testserver.ts`) som
snakker den delen av FHIR REST som klienten faktisk bruker: les, vread, søk via
`POST _search`, opprett, oppdater, slett, transaksjon, `$everything`,
`$validate` og `metadata`. Den finnes for at testene skal kunne kjøre uten
Docker, og gjør at vokteren testes over ekte HTTP.

Dobbelen er også partisjonsbevisst: den legger ressursene i hvert sitt lager per
partisjon og svarer på `$partition-management`-operasjonene, slik at isolasjonen
mellom virksomheter kan prøves over ekte HTTP.

Den er **ikke** en FHIR-server for produksjon. CI-jobbene `integrasjon-hapi` og
`integrasjon-hapi-partisjonert` kjører testene mot ekte `hapiproject/hapi` - med
og uten partisjonering - slik at kontrakten mot den virkelige serveren også blir
verifisert.

## Hva testene har avdekket

Testene er skrevet underveis, og har funnet feil som ellers ville nådd
produksjon:

1. **XML-parseren gikk i evig løkke** på input som ikke var XML — en melding fra
   en fremmed avsender kunne hengt tjenesten.
2. **Referanser med versjon** (`Observation/9/_history/2`) ga `_history` som
   ressurstype og versjonsnummeret som id.
3. **Normalisering av tekst** foldet «å», men ikke «ø» og «æ», fordi
   Unicode-dekomponering bare treffer bokstaver satt sammen av tegn og aksent.
4. **Hashen i sikkerhetsloggen** lot seg ikke reprodusere, fordi PostgreSQL
   normaliserer nøkkelrekkefølgen i `jsonb`. Integritetskontrollen ville slått ut
   på uskadde rader.
5. **Alle signeringsnøkler fikk samme `kid`**, fordi id-en ble utledet fra de
   første tegnene i en JSON-koding som er lik for alle P-256-nøkler.
6. **Innholdssikkerhetspolicyen blokkerte hydreringen.** Grensesnittet så
   riktig ut, men virket ikke i nettleseren.
7. **En lege kunne ikke gi en app `patient/`-scope**, fordi rollene beskrives med
   `user/`-scope og innsnevringen krevde eksakt samme kontekst.
8. **Ingen virksomhet kunne opprettes på en ny installasjon.** Plattformen hadde
   partisjons-id 2147483647, og neste ledige id ble regnet ut som
   `MAX(partisjon_id) + 1` - som gikk ut over heltallsområdet. Systemvirksomheter
   har nå ingen partisjon i det hele tatt.
9. **Standardvirksomheten hadde alltid adressen `http://localhost:5173`**, fordi
   migrasjonen la den inn og SQL ikke kan lese miljøvariabler. Enhver
   installasjon på en annen adresse fikk feil `issuer` i OAuth-metadata og feil
   `iss` ved app-oppstart, som ga avvisning i `aud`-kontrollen.
10. **Standardvirksomhetens partisjon ble aldri opprettet i HAPI.** Migrasjonen
    kan ikke opprette den - den ligger i en annen tjeneste.

Punkt 6, 7 og 9 kunne bare finnes av ende-til-ende-tester i en ekte nettleser.

## Kontinuerlig integrasjon

`.github/workflows/ci.yml` kjører ved hver endring:

1. typekontroll av kode og komponenter,
2. enhets- og integrasjonstester mot PostgreSQL,
3. ende-til-ende-tester mot applikasjonen,
4. integrasjonstester mot ekte HAPI FHIR R5,
5. isolasjonstestene mot en HAPI-server med partisjonering slått på,
6. produksjonsbygg.

Punkt 4 og 5 er ikke kjørt i utviklingsmiljøet - det hadde ingen tilgjengelig
Docker-motor. Se [åpne punkter](apne-punkter.md).
