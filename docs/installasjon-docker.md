# Installasjon med Docker

Dette er den korteste veien til en kjørende installasjon: én maskin, tre
containere, og et par kommandoer. Oppsettet er godt nok for et enkeltstående
legekontor og for testmiljøer. For flere virksomheter, høy tilgjengelighet
eller drift i et driftssenter, se [installasjon-kubernetes.md](installasjon-kubernetes.md).

## Innhold

- [Hva som kjører](#hva-som-kjører)
- [Krav](#krav)
- [Kom i gang](#kom-i-gang)
- [Konfigurasjon](#konfigurasjon)
- [Multitenancy](#multitenancy)
- [Herding før produksjon](#herding-før-produksjon)
- [TLS og omvendt proxy](#tls-og-omvendt-proxy)
- [Sikkerhetskopi](#sikkerhetskopi)
- [Oppgradering](#oppgradering)
- [Feilsøking](#feilsøking)

## Hva som kjører

| Container  | Bilde                  | Rolle                                              | Utadvendt |
| ---------- | ---------------------- | -------------------------------------------------- | --------- |
| `postgres` | `postgres:16-alpine`   | To databaser: `epj` (identitet, tilgang, logg) og `hapi` (kliniske data) | nei |
| `hapi`     | `hapiproject/hapi:v8.0.0` | HAPI FHIR JPA-server, R5, partisjonert per virksomhet | **nei** |
| `epj`      | bygges lokalt          | Journalen, FHIR-fasaden og OAuth-serveren          | ja        |

Det viktigste i tegningen er hva som *ikke* er utadvendt. HAPI har ingen egen
tilgangskontroll som kjenner norske krav til tjenstlig behov, sperring og
nødrett. Derfor ligger den på et internt nettverk uten publiserte porter, og
eneste vei inn er `/fhir`-fasaden i `epj`, som håndhever tilgang og skriver
sikkerhetslogg for hvert eneste kall. Publiserer du HAPI-porten, har du i
praksis slått av tilgangskontrollen i journalen.

```
                    ┌──────────── nettverk «ute» ────────────┐
   internett ──TLS──▶  epj (SvelteKit, port 3000)            │
                    └───────────────┬─────────────────────────┘
                                    │ nettverk «internt», ingen rute ut
                       ┌────────────┴────────────┐
                       ▼                         ▼
                  hapi (FHIR R5)            postgres 16
                       └──── jdbc ───────────────┘
```

## Krav

- Docker Engine 24 eller nyere, med Compose v2 (`docker compose version`)
- 4 GB ledig minne. HAPI alene er satt opp med 2 GB heap.
- 10 GB disk til å begynne med. Kliniske data og sikkerhetsloggen vokser.

## Kom i gang

```bash
git clone https://github.com/mobilars/epj.git
cd epj
cp .env.example .env

# Krypteringsnøkkelen beskytter TOTP-hemmeligheter og private signeringsnøkler
# i databasen. Mister du den, må alle brukere sette opp totrinnsverifisering
# på nytt, og utstedte tokens må trekkes tilbake.
echo "EPJ_DATA_KEY=$(openssl rand -base64 48)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env

docker compose up -d --build
```

Første oppstart tar noen minutter: HAPI oppretter sitt eget skjema, og
`epj`-containeren kjører migrasjonene i `epj`-databasen ved oppstart.

Følg med til alt er friskt:

```bash
docker compose ps
docker compose logs -f epj
curl -s localhost:3000/api/helse | jq
```

`/api/helse` svarer `{"status":"oppe", ...}` når både databasen og FHIR-serveren
svarer.

### Demodata

I et testmiljø kan du legge inn demopasienter og demobrukere:

```bash
docker compose exec epj node build/verktoy/seed.js
```

Skriptet nekter å kjøre hvis virksomheten allerede har brukere, så det kan ikke
brukes til å overskrive et miljø i drift. Det oppretter fem brukere med passord
`Testpassord1!` og en felles TOTP-hemmelighet. **Bruk det aldri i produksjon.**

## Konfigurasjon

All konfigurasjon er miljøvariabler. `.env.example` er fasiten; her er det som
oftest må settes.

| Variabel                   | Betydning                                                        |
| -------------------------- | ---------------------------------------------------------------- |
| `EPJ_BASE_URL`             | Kanonisk utadvendt adresse. Brukes som `issuer` i OAuth-metadata. |
| `EPJ_DATA_KEY`             | Krypteringsnøkkel for data at rest. **Obligatorisk.**             |
| `EPJ_HTTPS_ONLY`           | `true` i produksjon. Setter `Secure` på informasjonskapsler og HSTS. |
| `EPJ_REQUIRE_MFA`          | Krev totrinnsverifisering ved lokal pålogging.                    |
| `EPJ_TESTINNLOGGING`       | Lokal brukernavn/passord-pålogging. **`false` i produksjon.**      |
| `EPJ_HELSEID_*`            | HelseID som pålogging. Se [integrasjoner.md](integrasjoner.md).    |
| `EPJ_INTEGRASJON_MODUS`    | `mock` kjører SFM, NHN og Helfo lokalt. `live` krever oppkobling.  |
| `EPJ_HAPI_MULTITENANT`     | Partisjonering i HAPI. Se under.                                  |
| `EPJ_PLATTFORM_VERTSNAVN`  | Vertsnavnet `/systemadmin` nås på.                                |
| `EPJ_TILLAT_UKJENT_VERTSNAVN` | `false` i produksjon.                                          |

Hemmeligheter hører ikke hjemme i `docker-compose.yml`. Compose leser `.env`
automatisk; sørg for at filen har `chmod 600` og ikke ligger i git (den står i
`.gitignore`).

## Multitenancy

Én installasjon kan betjene flere legekontorer. Hver virksomhet får sin egen
partisjon i HAPI, og alt i applikasjonsdatabasen merkes med virksomheten.
Compose-filen slår dette på:

```yaml
HAPI_FHIR_TENANT_IDENTIFICATION_STRATEGY: URL_BASED
HAPI_FHIR_PARTITIONING_ALLOW_REFERENCES_ACROSS_PARTITIONS: 'false'
HAPI_FHIR_PARTITIONING_CROSS_PARTITION_REFERENCE_MODE: 'NOT_ALLOWED'
```

`ALLOW_REFERENCES_ACROSS_PARTITIONS: false` er det som gjør at en ressurs i én
virksomhet ikke kan peke inn i en annen - heller ikke ved en feil i vår egen
kode.

Virksomheten en forespørsel gjelder utledes av **vertsnavnet**, aldri av noe
klienten kan velge. Derfor trenger hver virksomhet sitt eget vertsnavn:

```
legekontoret-a.example.no  →  virksomhet «legekontor-a»  →  partisjon «legekontor-a»
legekontoret-b.example.no  →  virksomhet «legekontor-b»  →  partisjon «legekontor-b»
admin.example.no           →  plattformadministrasjon (/systemadmin)
```

Sett `EPJ_PLATTFORM_VERTSNAVN=admin.example.no`. Da er `/systemadmin` bare
tilgjengelig der, og virksomhetenes sider er utilgjengelige på det vertsnavnet.
Det gjør det mulig å legge en nettverksbegrensning foran plattformadministrasjonen
uten å røre resten.

### Opprette den første virksomheten

1. Logg inn på plattformvertsnavnet med en bruker som har rollen `systemeier`.
2. Gå til `/systemadmin` og fyll ut skjemaet: maskinnavn (blir partisjonsnavn og
   kan ikke endres siden), navn, organisasjonsnummer, vertsnavn og utadvendt
   adresse.
3. Oppgi et brukernavn for den første systemansvarlige. Du får et midlertidig
   passord som vises **én gang**.

Partisjonen opprettes i HAPI *før* virksomheten lagres. Feiler partisjonen, blir
det ingen virksomhet - en virksomhet uten fungerende klinisk lager er verre enn
ingen virksomhet.

Oversikten krysser registeret mot partisjonene HAPI faktisk har, og melder fra
om avvik. Det er en driftsfeil som skal synes.

### Én virksomhet

Kjører du for ett enkelt legekontor, kan du sette `EPJ_HAPI_MULTITENANT=false`
og droppe `HAPI_FHIR_TENANT_IDENTIFICATION_STRATEGY`. Da ligger de kliniske
dataene i HAPI sin standardpartisjon, og FHIR-adressene blir `/fhir/Patient/123`
uten virksomhetsledd. Alt annet virker likt.

## Herding før produksjon

Referanseoppsettet er laget for at det skal virke med én kommando. Før det tar
imot ekte pasientopplysninger må dette gjøres:

1. **Fjern publiserte porter fra `hapi` og `postgres`.** I `docker-compose.yml`
   ligger de der bare for lokal feilsøking. Kommenter ut `ports:`-blokkene.
2. **Slå av testinnlogging:** `EPJ_TESTINNLOGGING=false`, `EPJ_VIS_DEMOBRUKERE=false`.
   HelseID er hovedveien inn (`EPJ_HELSEID_ENABLED=true`).
3. **Slå på HTTPS:** `EPJ_HTTPS_ONLY=true`, og sett `EPJ_BASE_URL` til
   `https://…`.
4. **Avvis ukjent vertsnavn:** `EPJ_TILLAT_UKJENT_VERTSNAVN=false`.
5. **Sett `NODE_ENV=production`** (allerede satt i compose-filen).
6. **TLS mot PostgreSQL** og kryptert lagring på volumet. Normen krever
   kryptering av helseopplysninger i ro; `EPJ_DATA_KEY` dekker bare de
   kolonnene vi krypterer selv (TOTP-hemmeligheter og private nøkler), ikke
   journalen.
7. **Sett en autentisering mellom `epj` og `hapi`** hvis containerne kan nås av
   noe annet enn hverandre: `EPJ_HAPI_USER`/`EPJ_HAPI_PASSWORD` mot HAPI sin
   Basic-autentisering.
8. **Loggutlevering.** Sikkerhetsloggen er hash-lenket og append-only i
   databasen. Send den også til et skrivebeskyttet arkiv utenfor maskinen, slik
   at en som får `root` ikke kan endre historikken uten at det oppdages.

Sjekklisten i [drift.md](drift.md) går gjennom det samme mer utførlig.

## TLS og omvendt proxy

`epj` snakker ren HTTP på port 3000. Sett en omvendt proxy foran som avslutter
TLS. Med Caddy holder det med:

```caddyfile
legekontoret-a.example.no, legekontoret-b.example.no {
	reverse_proxy epj:3000
}

admin.example.no {
	# Plattformadministrasjonen: bare fra driftsnettet.
	@ute not remote_ip 10.0.0.0/8
	respond @ute 403
	reverse_proxy epj:3000
}
```

Proxyen må sende videre den opprinnelige `Host`-headeren - det er den
virksomheten utledes fra. Med nginx betyr det `proxy_set_header Host $host;`.
Sender proxyen sitt eget vertsnavn, havner alle forespørsler i feil virksomhet
eller blir avvist.

`X-Forwarded-For` brukes til klient-IP i sikkerhetsloggen. Sett den i proxyen,
og sørg for at ingen andre kan nå `epj`-containeren direkte, ellers kan headeren
forfalskes.

## Sikkerhetskopi

Begge databasene må sikkerhetskopieres, og de må være **konsistente med
hverandre**: `epj` inneholder sikkerhetsloggen som viser hvem som har lest hva i
`hapi`.

```bash
docker compose exec -T postgres pg_dump -U epj -Fc epj  > epj-$(date +%F).dump
docker compose exec -T postgres pg_dump -U epj -Fc hapi > hapi-$(date +%F).dump
```

Ta dem i samme vedlikeholdsvindu, eller bruk `pg_basebackup` og PITR på hele
klyngen. Krypter kopiene, og øv på gjenoppretting - en sikkerhetskopi som aldri
er prøvd, er en antakelse.

Gjenoppretting:

```bash
docker compose stop epj hapi
docker compose exec -T postgres pg_restore -U epj -d epj  --clean < epj-2026-09-10.dump
docker compose exec -T postgres pg_restore -U epj -d hapi --clean < hapi-2026-09-10.dump
docker compose start hapi epj
```

Kontroller etterpå at loggkjeden fortsatt henger sammen: `/admin` viser
resultatet av verifiseringen per virksomhet.

## Oppgradering

```bash
git pull
docker compose build epj
docker compose up -d epj
```

Migrasjonene kjøres ved oppstart og er idempotente. Ta sikkerhetskopi først:
migrasjoner som legger til kolonner kan ikke rulles tilbake automatisk.

Ved oppgradering av HAPI-bildet: les HAPI sine egne merknader om
skjemaendringer, og regn med at første oppstart tar lang tid mens skjemaet
migreres. Ikke oppgrader `epj` og HAPI i samme vindu - da vet du ikke hva som
gikk galt.

## Feilsøking

**`epj` starter ikke, loggen sier «EPJ_DATA_KEY må settes».**
Variabelen mangler i `.env`. Den har med vilje ingen standardverdi i
produksjonsmodus.

**`/api/helse` sier at FHIR-serveren er nede.**
`docker compose logs hapi`. Første oppstart tar 1-3 minutter mens skjemaet
opprettes. Helsesjekken har `start_period: 120s` nettopp derfor.

**«Ukjent vertsnavn» med statuskode 404.**
Vertsnavnet er ikke registrert på noen virksomhet. Enten registrer det i
`/systemadmin`, eller sett `EPJ_TILLAT_UKJENT_VERTSNAVN=true` i et testmiljø.

**Plattformadministrasjonen svarer 404.**
`/systemadmin` er bare tilgjengelig på `EPJ_PLATTFORM_VERTSNAVN`. Er variabelen
tom, er den tilgjengelig overalt - men da bør du sette den.

**«Klarte ikke å opprette FHIR-partisjon».**
HAPI kjører uten partisjonering. Kontroller at
`HAPI_FHIR_TENANT_IDENTIFICATION_STRATEGY: URL_BASED` er satt, og at HAPI er
startet på nytt etterpå.

**Sikkerhetsloggen verifiserer ikke.**
Se [drift.md](drift.md). Kjeden brytes av at rader er endret eller fjernet
utenom applikasjonen - blant annet av en gjenoppretting som bare tok med deler
av loggen.
