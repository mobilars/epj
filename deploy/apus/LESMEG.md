# Installasjon på apus-klyngen

Miljøspesifikt overlag over [`deploy/kubernetes/`](../kubernetes). Grunnoppsettet
der er generisk og uendret; her ligger bare det som er sant for denne klyngen.

| | |
| --- | --- |
| Klynge | microk8s, tre noder, Calico |
| Inngang | ingress-nginx i navnerommet `ingress`, klasse `public` |
| Sertifikater | cert-manager, utsteder `letsencrypt-prod` |
| Database | CloudNativePG i `cnpg-system` |
| Register | i klyngen, `localhost:32000` på nodene |
| Adresse | <https://epj.apps.apus.no> |

## Det overlaget endrer

| Fra grunnoppsettet | Her | Hvorfor |
| --- | --- | --- |
| StatefulSet `postgres` | `Cluster` fra CloudNativePG | Failover, WAL-arkivering og TLS uten at noen må gjøre det manuelt |
| `postgres:5432` | `postgres-rw:5432` | Operatøren navngir tjenestene sine selv |
| `example.no` | `epj.apps.apus.no` | |
| `ingressClassName: nginx` | `public` | Klassenavnet i denne klyngen |
| `letsencrypt` | `letsencrypt-prod` | Utstederens navn i denne klyngen |
| `ghcr.io/mobilars/epj` | `localhost:32000/epj` | Registeret i klyngen |
| 2 instanser, HAPI med 2 GB | 1 instans, HAPI med 1 GB | Nodene har under 4 GB hver |
| HelseID, `live`-integrasjoner | Testinnlogging, `mock` | Ingen HelseID-klient er registrert for oss |

De tre siste linjene i tabellen betyr at **dette ikke er et klinisk driftsmiljø**.
Se `konfigurasjon.yaml`, som sier det samme der verdiene settes.

## Installasjon

Databasepassordet må stå to steder med samme verdi: i `epj-hemmeligheter`, som
applikasjonen og HAPI leser, og i `postgres-legitimasjon`, som CloudNativePG
bruker når den oppretter eieren av databasen. Lag dem derfor i samme kommando:

```bash
PW="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"

kubectl create namespace epj

kubectl -n epj create secret generic epj-hemmeligheter \
  --from-literal=EPJ_DATA_KEY="$(openssl rand -base64 48)" \
  --from-literal=POSTGRES_PASSWORD="$PW" \
  --from-literal=EPJ_HELSEID_PRIVATE_KEY='' \
  --from-literal=EPJ_HAPI_PASSWORD=''

kubectl -n epj create secret generic postgres-legitimasjon \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=epj \
  --from-literal=password="$PW"
```

`EPJ_DATA_KEY` krypterer TOTP-hemmeligheter og private signeringsnøkler.
Mistes den, må alle brukere sette opp totrinnsverifisering på nytt, og alle
utstedte tokens blir ugyldige.

Så selve oppsettet:

```bash
kubectl apply -k deploy/apus
kubectl -n epj rollout status deploy/hapi --timeout=15m   # bygger skjemaet
kubectl -n epj rollout status deploy/epj
```

Applikasjonen kjører migrasjonene selv ved første forespørsel. Demodata legges
inn med en egen jobb, som ikke er en del av overlaget:

```bash
kubectl -n epj apply -f deploy/apus/seed-job.yaml
kubectl -n epj logs -f job/epj-seed        # TOTP-hemmelighetene skrives hit
```

## Bygg og utrulling

CI bygger bildet og ruller det ut; se [`.woodpecker.yaml`](../../.woodpecker.yaml)
og `ci-rbac.yaml`. Manuelt bygg uten Docker-motor lokalt, med kaniko i klyngen:

```bash
# Kildekoden inn på et volum
kubectl -n woodpecker apply -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: epj-bygg, namespace: woodpecker}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: microk8s-hostpath
  resources: {requests: {storage: 6Gi}}
YAML

# ... last opp kildekoden, og kjør kaniko som podens egen kommando.
# Kaniko pakker ut basisbildet over containerens rotfilsystem, og kan derfor
# ikke kjøres med `kubectl exec` inn i en pod som sover: den river bort
# filsystemet under prosessen som holder poden i live.
```

## Feilsøking

**`/api/helse` svarer 503 med `"fhir": false`.** HAPI svarer, men ikke på
partisjonsstien. Kontroller at partisjoneringen faktisk er slått på:

```bash
kubectl -n epj exec deploy/epj -- \
  node -e "fetch('http://hapi:8080/fhir/standard/metadata').then(r=>console.log(r.status))"
```

Svarer den 404 med «Unknown resource type 'standard'», leser ikke HAPI
partisjonsnøklene. De må settes i `SPRING_APPLICATION_JSON`, ikke som egne
miljøvariabler - se merknaden i [`04-hapi.yaml`](../kubernetes/04-hapi.yaml).

**`password authentication failed for user "epj"`.** Enten står `$(POSTGRES_PASSWORD)`
uutvidet i URL-en - da er miljøvariabelen definert *etter* `EPJ_DATABASE_URL` i
lista, og Kubernetes utvider bare bakover - eller så er de to hemmelighetene
over ikke i takt.

**Skrivinger mot API-tjeneren henger, mens lesinger går.** Da er det ikke dette
oppsettet, men klyngens datalager. Kontroller `microk8s status` på nodene.
