# Drift

Installasjon står i [installasjon-docker.md](installasjon-docker.md) og
[installasjon-kubernetes.md](installasjon-kubernetes.md). Dette dokumentet
handler om det som kommer etterpå.

## Komponenter

| Komponent | Rolle | Eksponert |
| --- | --- | --- |
| `epj` | Applikasjon, API-fasade og OAuth-server | ja, bak TLS |
| `hapi` | HAPI FHIR JPA (R5), klinisk lager | **nei** |
| `postgres` | Databasene `epj` og `hapi` | nei |

HAPI skal aldri være tilgjengelig utenfra. I `docker-compose.yml` ligger den på
et internt nett uten publiserte porter; portpubliseringen som finnes der er kun
for lokal feilsøking og må fjernes i produksjon.

## Oppstart

```bash
cp .env.example .env
# sett EPJ_DATA_KEY:  openssl rand -base64 48
docker compose up -d
```

Migrasjonene kjøres automatisk ved første forespørsel, og er idempotente.

## Konfigurasjon

### Obligatorisk

| Variabel | Beskrivelse |
| --- | --- |
| `EPJ_BASE_URL` | Kanonisk utadvendt adresse. Brukes som `issuer` i OAuth-metadata |
| `EPJ_DATABASE_URL` | PostgreSQL for applikasjonsdata |
| `EPJ_HAPI_BASE_URL` | Intern adresse til HAPI |
| `EPJ_DATA_KEY` | Nøkkel for kryptering av data at rest |

`EPJ_DATA_KEY` krypterer TOTP-hemmeligheter og private signeringsnøkler. Mistes
den, må alle brukere sette opp totrinnsverifisering på nytt, og alle utstedte
tokens blir ugyldige. Den skal ligge i en hemmelighetstjeneste, ikke i en fil
ved siden av koden.

### Sikkerhet

| Variabel | Standard | Beskrivelse |
| --- | --- | --- |
| `EPJ_HTTPS_ONLY` | `true` i produksjon | HSTS og Secure-cookies |
| `EPJ_REQUIRE_MFA` | `true` | Krev totrinnsverifisering |
| `EPJ_MAX_FAILED_LOGINS` | `5` | Forsøk før utestengelse |
| `EPJ_LOCKOUT_SECONDS` | `900` | Utestengelsens varighet |
| `EPJ_SESSION_IDLE_SECONDS` | `1800` | Inaktivitetsgrense |
| `EPJ_SESSION_ABSOLUTE_SECONDS` | `43200` | Absolutt levetid |
| `EPJ_TRUSTED_PROXY_HOPS` | `1` | Hopp i `X-Forwarded-For` som kan stoles på |
| `EPJ_RATE_AUTH` | `20` | Påloggingskall per minutt per IP |
| `EPJ_RATE_GENERELL` | `600` | Øvrige kall per minutt per IP |
| `EPJ_RATE_LOGIN_BRUKER` | `10` | Påloggingsforsøk per brukernavn per 5 min |

Sett `EPJ_TRUSTED_PROXY_HOPS` riktig. For lavt gir feil IP i loggen; for høyt
lar en klient sette sin egen adresse, og da blir ratebegrensningen og loggen
verdiløs.

### Pålogging

| Variabel | Beskrivelse |
| --- | --- |
| `EPJ_HELSEID_ENABLED` | Slår på HelseID |
| `EPJ_HELSEID_ISSUER` | `https://helseid-sts.nhn.no` i produksjon |
| `EPJ_HELSEID_CLIENT_ID` | Klient-id fra NHN |
| `EPJ_HELSEID_PRIVATE_KEY` | Privat nøkkel (PKCS#8) for klientassertions |
| `EPJ_HELSEID_KEY_ID` | `kid` som svarer til nøkkelen |
| `EPJ_HELSEID_ALG` | `RS256` eller `PS256` |
| `EPJ_TESTINNLOGGING` | **Sett `false` i produksjon** |

### Tokens og nøkler

| Variabel | Standard |
| --- | --- |
| `EPJ_ACCESS_TOKEN_TTL` | `600` |
| `EPJ_REFRESH_TOKEN_TTL` | `2592000` |
| `EPJ_AUTH_CODE_TTL` | `60` |
| `EPJ_LAUNCH_TTL` | `300` |
| `EPJ_ROTATE_REFRESH_TOKENS` | `true` |
| `EPJ_KEY_ROTATION_DAYS` | `90` |

## Sjekkliste før produksjon

- [ ] `EPJ_DATA_KEY` fra hemmelighetstjeneste, ikke fra fil
- [ ] `EPJ_TESTINNLOGGING=false`
- [ ] `EPJ_HELSEID_ENABLED=true` med produksjonsutsteder
- [ ] `EPJ_HTTPS_ONLY=true`, TLS terminert foran applikasjonen
- [ ] HAPI uten publiserte porter og uten rute ut
- [ ] PostgreSQL med TLS og kryptert lagring
- [ ] `EPJ_TRUSTED_PROXY_HOPS` avstemt mot faktisk proxy-oppsett
- [ ] Sikkerhetskopi av begge databaser, med testet gjenoppretting
- [ ] Overvåking av `/api/helse`
- [ ] Rutine for gjennomgang av nødrettsoppslag
- [ ] Periodisk verifisering av loggkjeden
- [ ] Takstbeløp oppdatert fra gjeldende normaltariff
- [ ] Databehandleravtaler for alle registrerte apper
- [ ] Risikovurdering og personvernkonsekvensvurdering gjennomført
- [ ] `EPJ_TILLAT_UKJENT_VERTSNAVN=false`
- [ ] `EPJ_PLATTFORM_VERTSNAVN` satt, og `/systemadmin` begrenset på nettverksnivå
- [ ] Virksomhetsregisteret stemmer med partisjonene i HAPI (kontrolleres i `/systemadmin`)
- [ ] Penetrasjonstest gjennomført av noen andre enn den som bygget systemet

## Overvåking

```
GET /api/helse
```

```json
{"status":"ok","database":true,"fhir":true,"skjemaversjon":2}
```

Svarer `503` når en avhengighet er nede. Endepunktet røper ikke interne
adresser eller versjoner.

Administrasjonssiden viser i tillegg loggens integritet, antall aktive brukere
og apper, meldinger uten kvittering, og nødrettsoppslag til gjennomgang.

## Sikkerhetskopi

To databaser må sikres:

* **`epj`** — identitet, roller, sikkerhetslogg, meldinger, oppgjør.
* **HAPI-databasen** — kliniske data og versjonshistorikk.

De må sikres konsistent i forhold til hverandre: en journal uten logg, eller en
logg uten journal, er begge et avvik.

`EPJ_DATA_KEY` må sikres uavhengig av databasene. En sikkerhetskopi uten
nøkkelen gir ikke tilbake totrinnsverifisering.

## Flere virksomheter

Én installasjon betjener flere legekontorer. Å legge til en ny:

1. Sett opp vertsnavnet i inngangen (DNS, TLS-sertifikat, Ingress eller proxy).
2. Opprett virksomheten i `/systemadmin` med det samme vertsnavnet. Partisjonen i
   HAPI opprettes før virksomheten lagres, så en virksomhet peker aldri på en
   partisjon som ikke finnes.
3. Opprett den første systemansvarlige i samme skjema. Det midlertidige passordet
   vises **én gang**.

Oversikten i `/systemadmin` krysser registeret mot partisjonene HAPI faktisk har.
Et avvik der er en driftsfeil: enten er en partisjon slettet, eller så peker en
virksomhet på en partisjon som aldri ble opprettet. Kliniske spørringer i den
virksomheten vil feile til det er rettet.

**Suspensjon** virker umiddelbart: alle sesjoner avsluttes og alle utstedte
tokens trekkes tilbake i samme transaksjon. Kliniske data røres ikke, så
virksomheten kan aktiveres igjen uten tap.

**Avvikling** gjør i dag det samme som suspensjon, og sletter ikke partisjonen.
Det er med vilje: journalene skal oppbevares i mange år etter at et legekontor er
lagt ned. En reell avviklingsflyt står i [todo.md](todo.md) punkt 4.1.

Hver virksomhet har sin egen hash-kjede i sikkerhetsloggen og sine egne
signeringsnøkler. Verifisering og nøkkelrotasjon må derfor gjøres per virksomhet;
`/admin` viser tilstanden for den virksomheten man er pålogget.

## Nøkkelrotasjon

Signeringsnøkler roteres automatisk etter `EPJ_KEY_ROTATION_DAYS`. Gamle nøkler
blir i JWKS til utstedte tokens er utløpt, slik at rotasjon ikke gir nedetid for
SMART-apper. Manuell rotasjon ved mistanke om kompromittering gjøres med
`roterNokkel()`; tilbakekalling av alle tokens er en egen handling.

## Vedlikehold

Følgende bør kjøres periodisk. Funksjonene finnes; jobbplanleggingen er ikke
implementert (se [åpne punkter](apne-punkter.md)).

| Oppgave | Funksjon | Foreslått hyppighet |
| --- | --- | --- |
| Send meldingskø | `sendKo()` | hvert minutt |
| Rydd utløpte tokens | `ryddUtlopteTokens()` | daglig |
| Rydd utløpte koder og launch-kontekster | `ryddUtlopteKoder()` | daglig |
| Rydd utløpte sesjoner | `ryddUtlopteSesjoner()` | daglig |
| Rydd ratebegrensningstellere | `ryddRateLimit()` | daglig |
| Fjern utdaterte nøkler | `fjernUtdaterteNokler()` | ukentlig |
| Verifiser loggkjeden | `verifiserLoggkjede()` | daglig |

## Oppgradering

Migrasjoner er versjonerte SQL-filer i `src/lib/server/db/migrations/`, kjørt i
rekkefølge og bare én gang. De kjører automatisk ved oppstart, eller manuelt med
`npm run migrer`.

HAPI håndterer sine egne skjemaendringer. Ved oppgradering av HAPI bør
`/fhir/metadata` kontrolleres, og testsuiten kjøres mot den nye versjonen.

## Feilsøking

| Symptom | Kontroller |
| --- | --- |
| `503` fra `/api/helse` | Svarer HAPI på `/fhir/metadata`? Er databasen oppe? |
| Alle FHIR-kall gir `401` | Klokkeavvik mellom instansene? Er nøkkelen rotert bort? |
| Alle FHIR-kall gir `403` | Mangler brukeren behandlingsrelasjon? Er scope snevret inn? |
| Pålogging feiler med krypteringsfeil | `EPJ_DATA_KEY` er endret siden hemmelighetene ble lagret |
| Meldinger blir stående i kø | Er meldingstjeneren nådd? Se `status_detalj` på meldingen |
| Loggkjeden er brutt | Rader er endret utenom applikasjonen. Behandles som sikkerhetsavvik |
