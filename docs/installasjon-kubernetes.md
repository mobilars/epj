# Installasjon i Kubernetes

Manifestene ligger i [`deploy/kubernetes/`](../deploy/kubernetes). De er skrevet
for å leses: hver fil forklarer hva den gjør og hvorfor. Vil du bare komme i
gang på én maskin, er [installasjon-docker.md](installasjon-docker.md) kortere.

## Innhold

- [Tegningen](#tegningen)
- [Krav](#krav)
- [Installasjon](#installasjon)
- [Miljøspesifikke overlag](#miljøspesifikke-overlag)
- [Nettverkspolicyene](#nettverkspolicyene)
- [Multitenancy](#multitenancy)
- [Oppgradering](#oppgradering)
- [Sikkerhetskopi](#sikkerhetskopi)
- [Drift](#drift)
- [Feilsøking](#feilsøking)

## Tegningen

```
                       Ingress (TLS)
      legekontoret-a.example.no ─┐
      legekontoret-b.example.no ─┼──▶ Service epj ──▶ Deployment epj (2+)
      admin.example.no ──────────┘                          │
      (begrenset til driftsnettet)                          │
                                                            │ NetworkPolicy
                                          ┌─────────────────┴───────────┐
                                          ▼                             ▼
                              Service hapi (ClusterIP)          Service postgres
                              Deployment hapi (FHIR R5)         StatefulSet postgres
                                          │                             ▲
                                          └────────── jdbc ─────────────┘
```

Det viktigste er hva som ikke har en inngang. **HAPI FHIR har ingen Ingress og
ingen NodePort.** HAPI kjenner ikke norske krav til tjenstlig behov, sperring og
nødrett, og skriver ikke vår sikkerhetslogg. Eneste vei inn til kliniske data er
`/fhir`-fasaden i `epj`, som håndhever tilgang og logger hvert kall. Åpner du en
Ingress mot HAPI, har du slått av tilgangskontrollen i journalen.

Applikasjonen er tilstandsløs - sesjoner, tokens og ratebegrensning ligger i
PostgreSQL - og kan derfor skaleres fritt.

## Krav

- Kubernetes 1.28 eller nyere
- **En CNI som håndhever NetworkPolicy** (Calico, Cilium, Antrea). Uten dette
  er `10-nettverk.yaml` bare dokumentasjon, og HAPI er tilgjengelig for alt som
  kjører i klyngen. Kontroller at policyene faktisk virker; se
  [Nettverkspolicyene](#nettverkspolicyene).
- En Ingress-kontroller. Manifestene forutsetter `ingress-nginx` og
  cert-manager, men enhver kontroller som sender videre den opprinnelige
  `Host`-headeren duger.
- En lagringsklasse med `ReadWriteOnce`, helst med kryptering i ro.
- Et containerregister med bildet. Bygg det fra `docker/Dockerfile`.

## Installasjon

### 1. Bygg og publiser bildet

```bash
docker build -f docker/Dockerfile -t ghcr.io/mobilars/epj:1.0.0 .
docker push ghcr.io/mobilars/epj:1.0.0
```

Bruk en versjonsmerkelapp, ikke `latest`. Et journalsystem skal kunne rulles
tilbake til nøyaktig det som kjørte i går.

### 2. Navnerom og hemmeligheter

```bash
kubectl apply -f deploy/kubernetes/00-namespace.yaml

kubectl -n epj create secret generic epj-hemmeligheter \
  --from-literal=EPJ_DATA_KEY="$(openssl rand -base64 48)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=EPJ_HELSEID_PRIVATE_KEY="$(cat helseid.pem)" \
  --from-literal=EPJ_HAPI_PASSWORD=""
```

`01-hemmeligheter.yaml` er en mal med tomme verdier. Den er ment for å vise
hvilke nøkler som trengs, ikke for å fylles ut i git. I et driftsmiljø bør
hemmelighetene komme fra External Secrets, Vault eller Sealed Secrets.

`EPJ_DATA_KEY` krypterer TOTP-hemmeligheter og private signeringsnøkler i
databasen. Mister du den, må alle brukere sette opp totrinnsverifisering på
nytt og alle utstedte tokens trekkes tilbake. Ta vare på den et annet sted enn
sikkerhetskopiene - en kopi som inneholder både data og nøkkel er ikke kryptert
i praksis.

### 3. Konfigurasjon

Rediger `02-konfigurasjon.yaml`: `EPJ_BASE_URL`, `EPJ_PLATFORM_HOSTNAME` og
HelseID-verdiene. Verdiene i filen er satt for produksjon - testinnlogging av,
HTTPS påkrevd, ukjente vertsnavn avvist.

```bash
kubectl apply -f deploy/kubernetes/02-konfigurasjon.yaml
```

### 4. Database og FHIR-server

```bash
kubectl apply -f deploy/kubernetes/03-postgres.yaml
kubectl -n epj rollout status statefulset/postgres

kubectl apply -f deploy/kubernetes/04-hapi.yaml
kubectl -n epj rollout status deployment/hapi --timeout=10m
```

HAPI oppretter sitt eget skjema ved første oppstart, og det tar flere minutter.
`startupProbe` er satt med `failureThreshold: 60` nettopp derfor.

For et driftsmiljø bør `03-postgres.yaml` byttes ut med en styrt database med
punkt-i-tid-gjenoppretting og synkron replikering - CloudNativePG, Crunchy
Postgres eller en driftet tjeneste. Resten av oppsettet bryr seg bare om at
tjenesten heter `postgres`.

### 5. Migrasjon og applikasjon

```bash
# Skjemaendringen som eget steg, før nye instanser rulles ut.
kubectl -n epj delete job epj-migrer --ignore-not-found
kubectl apply -f deploy/kubernetes/06-migrasjon.yaml
kubectl -n epj wait --for=condition=complete job/epj-migrer --timeout=5m
kubectl -n epj logs job/epj-migrer

kubectl apply -f deploy/kubernetes/05-epj.yaml
kubectl -n epj rollout status deployment/epj
```

Applikasjonen kjører migrasjonene selv ved oppstart, og de er idempotente.
Jobben finnes for at du skal kunne se at skjemaendringen gikk bra *før*
trafikken flyttes.

### 6. Nettverk og inngang

```bash
kubectl apply -f deploy/kubernetes/10-nettverk.yaml
kubectl apply -f deploy/kubernetes/11-ingress.yaml
```

Rediger vertsnavnene i `11-ingress.yaml` først. Hvert vertsnavn må også
registreres på en virksomhet i `/systemadmin`, ellers avvises forespørslene.

### 7. Kontroller

```bash
kubectl -n epj get pods
curl -s https://legekontoret-a.example.no/api/helse | jq
```

## Miljøspesifikke overlag

Manifestene i denne mappen er generiske. De har `example.no` som vertsnavn,
`nginx` som ingressklasse og et StatefulSet som database - verdier som er riktige
som utgangspunkt og gale i enhver konkret klynge.

Legg derfor miljøet ditt som et kustomize-overlag ved siden av, ikke som
endringer i disse filene:

```
deploy/
  kubernetes/     # generisk, uendret
  apus/           # én klynge:  kubectl apply -k deploy/apus
```

[`deploy/apus/`](../deploy/apus) er et fullstendig eksempel, og er i drift. Det
bytter ut PostgreSQL med CloudNativePG, setter våre vertsnavn og
sertifikatutsteder, henter bildet fra registeret i klyngen, og skrur ned
ressursbruken til noder på under 4 GB. Se
[`deploy/apus/LESMEG.md`](../deploy/apus/LESMEG.md).

### HAPI leser ikke alle innstillinger fra miljøvariabler

Dette er den fellen som koster mest tid, og den gir ingen feilmelding som peker
på årsaken.

Spring binder miljøvariabler ved å gjøre om understrek til punktum. HAPI sine
nøkler har understrek i navnet - `fhir_version`,
`request_tenant_partitioning_mode`, `allow_references_across_partitions` - og
dialekten ligger under en kartnøkkel som bokstavelig heter
`hibernate.dialect`. En miljøvariabel treffer derfor en annen nøkkel enn den
som leses, og verdien havner et sted ingen ser etter. HAPI kjører videre på
standardverdien, uten et eneste varsel.

Følgene, slik de så ut i en klynge:

| Innstilling som ikke ble lest | Hva som skjedde |
| --- | --- |
| `hibernate.dialect` | HAPI ble stående på H2-dialekten og bygde skjemaet med `clob`- og `blob`-kolonner. PostgreSQL avviste 27 tabeller. Serveren startet likevel, og feilet først på første søk med «relation "hfj_resource" does not exist» |
| `partitioning` | `/fhir/<virksomhet>/` svarte 404 «Unknown resource type». `/api/helse` meldte `"fhir": false`, mens `/fhir/metadata` svarte 200 |

Konfigurasjonen monteres derfor som fil, gjennom
`SPRING_CONFIG_ADDITIONAL_LOCATION`, som har høyere presedens enn
konfigurasjonen i bildet. `SPRING_APPLICATION_JSON` med flate nøkler er ikke
nok: dialekten endte da på Hibernates automatisk oppdagede `PostgreSQLDialect`
i stedet for HAPI sin egen. Ikke gjør disse om til miljøvariabler igjen fordi
det ser penere ut.

### Nøkkelen for virksomhet i URL-en heter ikke det dokumentasjonen sier

`tenant_identification_strategy: URL_BASED` står i mye dokumentasjon og i
eldre oppsett. **Den finnes ikke i v8.0.0.** Ordet «tenant» forekommer ikke én
gang i bildets egen `application.yaml`. Nøkkelen heter i stedet:

```yaml
hapi:
  fhir:
    partitioning:
      request_tenant_partitioning_mode: true
```

Merk også at `partitioning:` i seg selv slår på partisjonering. Setter du
blokken uten en modus som tildeler partisjon, feiler *hver eneste skriving* med:

```
HAPI-1319: No interceptor provided a value for pointcuts:
[STORAGE_PARTITION_IDENTIFY_CREATE, STORAGE_PARTITION_IDENTIFY_ANY]
```

Altså: halvveis påslått partisjonering er verre enn ingen. De to hører sammen.

Kontroller etter oppgradering av HAPI:

```bash
kubectl -n epj exec deploy/epj -- node -e   "fetch('http://hapi:8080/fhir/standard/metadata').then(r=>console.log(r.status))"
```

`200` betyr at partisjoneringen er på. `404` betyr at den ikke er det.

### Rekkefølgen på miljøvariabler betyr noe

`EPJ_DATABASE_URL` bruker `$(POSTGRES_PASSWORD)`. Kubernetes utvider bare
variabler som er definert *tidligere* i `env`-lista. Står de i motsatt
rekkefølge, sendes strengen `$(POSTGRES_PASSWORD)` til databasen som passord, og
loggen viser `password authentication failed`.

Dette er lett å ødelegge med et overlag: en strategisk fletting flytter feltene
den rører fremst i lista. Et overlag som setter `EPJ_DATABASE_URL` må derfor
sette `POSTGRES_PASSWORD` også, og sette den først.

## Nettverkspolicyene

`10-nettverk.yaml` starter med å nekte alt, i begge retninger, og åpner så
nøyaktig det som trengs:

| Fra          | Til             | Port | Hvorfor                                  |
| ------------ | --------------- | ---- | ---------------------------------------- |
| ingress-nginx| `epj`           | 3000 | Trafikk utenfra                          |
| `epj`        | `hapi`          | 8080 | Kliniske data, gjennom fasaden           |
| `epj`        | `postgres`      | 5432 | Identitet, tilgang, logg, integrasjoner  |
| `epj`        | internett       | 443  | HelseID, SFM, NHN, Helfo                 |
| `hapi`       | `postgres`      | 5432 | Sitt eget skjema                         |
| `hapi`       | *ingenting ute* | -    | Det kliniske lageret har ingenting der å gjøre |

Legg merke til at `hapi` har **ingen** utgående regel mot internett. Skulle noen
klare å kjøre kode i den poden, kommer de ingen vei ut med det de finner.

**Kontroller at policyene håndheves.** En NetworkPolicy uten en CNI som
håndhever den gir falsk trygghet:

```bash
kubectl -n epj run test --rm -it --image=curlimages/curl --restart=Never \
  -- curl -m 5 -s http://hapi:8080/fhir/metadata
```

Den skal gå i tidsavbrudd. Får du et CapabilityStatement tilbake, håndheves ikke
policyene, og HAPI er tilgjengelig for alt i navnerommet.

## Multitenancy

Én installasjon betjener flere legekontorer. Hver virksomhet får sin egen
partisjon i HAPI (`HAPI_FHIR_TENANT_IDENTIFICATION_STRATEGY: URL_BASED`), og alt
i applikasjonsdatabasen merkes med virksomheten.

`ALLOW_REFERENCES_ACROSS_PARTITIONS: false` og
`CROSS_PARTITION_REFERENCE_MODE: NOT_ALLOWED` i `04-hapi.yaml` gjør at en
ressurs i én virksomhet ikke kan peke inn i en annen - heller ikke ved en feil i
vår egen kode.

Virksomheten utledes av **vertsnavnet**, aldri av noe klienten kan velge. Å
legge til en virksomhet er derfor to ting:

1. Legg vertsnavnet inn i `11-ingress.yaml` (og i `tls.hosts`), og bruk
   manifestet på nytt.
2. Opprett virksomheten i `/systemadmin` med det samme vertsnavnet. Partisjonen
   opprettes i HAPI før virksomheten lagres, så en virksomhet peker aldri på en
   partisjon som ikke finnes.

Med cert-manager og et jokertegnsertifikat kan steg 1 gjøres én gang for hele
domenet, slik at nye virksomheter bare krever steg 2.

### Plattformadministrasjonen

`/systemadmin` er bare tilgjengelig på `EPJ_PLATFORM_HOSTNAME`, og
`11-ingress.yaml` begrenser i tillegg det vertsnavnet til driftsnettet med
`whitelist-source-range`. To uavhengige sperrer, fordi dette er grensesnittet
som ser på tvers av virksomheter.

Det gir likevel aldri klinisk innsyn: rollen `systemeier` har ingen scopes, så
FHIR-fasaden avviser den uansett.

### Størrelse

Én HAPI-instans betjener flere virksomheter. Partisjonering er ikke et hinder
for å skalere `hapi` - den tåler flere instanser mot samme database. Start med
én, og skaler når du har målt at det er FHIR-laget som er flaskehalsen, ikke
databasen.

`epj` skaleres av en HorizontalPodAutoscaler på CPU, med minst to instanser og
en PodDisruptionBudget som holder minst én i live gjennom nodevedlikehold.

## Oppgradering

```bash
# 1. Sikkerhetskopi først. Migrasjoner som legger til kolonner rulles ikke
#    tilbake automatisk.
# 2. Skjemaendringen som eget steg.
kubectl -n epj delete job epj-migrer --ignore-not-found
kubectl -n epj apply -f deploy/kubernetes/06-migrasjon.yaml
kubectl -n epj wait --for=condition=complete job/epj-migrer --timeout=5m

# 3. Ny versjon av applikasjonen.
kubectl -n epj set image deployment/epj epj=ghcr.io/mobilars/epj:1.1.0
kubectl -n epj rollout status deployment/epj
```

Utrullingen er `maxUnavailable: 0`, så journalen er tilgjengelig hele veien.
Går det galt: `kubectl -n epj rollout undo deployment/epj`.

Migrasjonene er skrevet slik at forrige og neste versjon av applikasjonen tåler
det samme skjemaet i utrullingsvinduet. Endringer som ikke kan det, deles i to
utrullinger.

Ikke oppgrader `epj` og HAPI i samme vindu. Går noe galt, vil du vite hvilken av
dem det var.

## Sikkerhetskopi

Begge databasene må sikkerhetskopieres, og de må være konsistente med hverandre:
`epj` inneholder sikkerhetsloggen som viser hvem som har lest hva i `hapi`.

```bash
kubectl -n epj exec statefulset/postgres -- \
  pg_dump -U epj -Fc epj  > epj-$(date +%F).dump
kubectl -n epj exec statefulset/postgres -- \
  pg_dump -U epj -Fc hapi > hapi-$(date +%F).dump
```

I et driftsmiljø settes dette opp som en CronJob mot et kryptert lager utenfor
klyngen, med punkt-i-tid-gjenoppretting. Øv på gjenoppretting - en
sikkerhetskopi som aldri er prøvd, er en antakelse.

Etter en gjenoppretting: kontroller at loggkjeden fortsatt henger sammen.
`/admin` viser resultatet per virksomhet, og `/systemadmin` viser om
virksomhetsregisteret stemmer med partisjonene HAPI faktisk har.

## Drift

**Helsesjekk.** `/api/helse` svarer på om databasen og FHIR-serveren er oppe. Den
brukes av startup-, readiness- og liveness-proben.

**Logg.** Applikasjonen skriver til stdout. Sikkerhetsloggen er noe annet: den
ligger hash-lenket og append-only i databasen. Send den også til et
skrivebeskyttet arkiv utenfor klyngen, slik at en som får kontroll over
klyngen ikke kan endre historikken uten at det oppdages.

**Ressurser.** HAPI er den tunge komponenten (2-3 GB). `epj` klarer seg med
256 MB per instans.

**Nedetid.** Med `replicas: 2`, `maxUnavailable: 0` og en PodDisruptionBudget
tåler journalen både utrulling og nodevedlikehold. Databasen med én instans gjør
det ikke - det er argumentet for en styrt database.

Se [drift.md](drift.md) for sjekklisten før produksjonssetting.

## Feilsøking

**Poden `epj` starter ikke: «EPJ_DATA_KEY må settes».**
Hemmeligheten mangler eller har feil nøkkelnavn.
`kubectl -n epj get secret epj-hemmeligheter -o jsonpath='{.data}' | jq keys`.

**`epj` er ikke klar: `/api/helse` sier at FHIR-serveren er nede.**
`kubectl -n epj logs deployment/hapi`. Ved første oppstart tar skjemaopprettelsen
flere minutter. Er HAPI oppe, men `epj` når den ikke: kontroller
nettverkspolicyen `hapi`.

**404 «Ukjent vertsnavn».**
Vertsnavnet er ikke registrert på noen virksomhet i `/systemadmin`. I et
testmiljø kan `EPJ_ALLOW_UNKNOWN_HOSTNAME: 'true'` brukes; i produksjon skal
det stå `false`.

**Alle forespørsler havner i samme virksomhet.**
Ingress-kontrolleren sender ikke videre den opprinnelige `Host`-headeren.
Med ingress-nginx er dette standard; med andre kontrollere må det settes.

**«Klarte ikke å opprette FHIR-partisjon».**
`HAPI_FHIR_TENANT_IDENTIFICATION_STRATEGY` er ikke `URL_BASED`, eller HAPI er
ikke startet på nytt etter at den ble satt.
`kubectl -n epj rollout restart deployment/hapi`.

**`/systemadmin` svarer 404.**
Den er bare tilgjengelig på `EPJ_PLATFORM_HOSTNAME`. Kontroller at verdien i
konfigurasjonen er den samme som vertsnavnet i `11-ingress.yaml`.

**Migrasjonsjobben feiler med «already exists».**
Jobben er kjørt før. `kubectl -n epj delete job epj-migrer` og prøv igjen;
migrasjonene i seg selv er idempotente.
