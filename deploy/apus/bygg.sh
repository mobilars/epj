#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bygger containerbildet i klyngen og publiserer det til registeret der.
#
#   deploy/apus/bygg.sh              # bygger HEAD, merker med kortsha + latest
#   deploy/apus/bygg.sh --rull-ut    # ruller også ut den nye merkelappen
#
# Hvorfor ikke i CI: klyngen har tre noder på under 4 GB. Et kaniko-bygg av
# dette prosjektet trenger rundt 3,5 GB, og et byggetrinn som spiser opp noden
# det kjører på tar med seg resten av klyngen. Bygget kjøres derfor når noen
# ser på, ikke ved hver push.
#
# Hvorfor kaniko og ikke `docker build`: utviklingsmaskinen har ikke
# nødvendigvis en Docker-motor, og registeret ligger inne i klyngen.
#
# Kaniko pakker ut basisbildet over containerens eget rotfilsystem. Den kan
# derfor ikke kjøres med `kubectl exec` inn i en pod som sover - den river bort
# filsystemet under prosessen som holder poden i live, og jobben dør med
# exit 137 uten at det er tom for minne. Kilden må være på plass *før* kaniko
# starter, og kaniko må være podens egen kommando. Derfor to trinn: en pod som
# tar imot kildekoden på et volum, og så jobben som bygger.
# ---------------------------------------------------------------------------
set -euo pipefail

NS_BYGG=${NS_BYGG:-woodpecker}       # bygget kjører her: `epj` håndhever
                                     # restricted PSS, og kaniko trenger root
NS_APP=${NS_APP:-epj}
PVC=${PVC:-epj-bygg}
NODE=${NODE:-}                       # tom = la planleggeren velge
REGISTER_INN=registry.container-registry.svc.cluster.local:5000/epj
REGISTER_UT=localhost:32000/epj      # slik nodene selv slår det opp
RULL_UT=nei

# Which cluster to talk to. Several clusters answer to this workstation, and the
# one that happens to be current is not always the one this overlay belongs to.
# Name the target instead of assuming it:
#
#   KUBE_CONTEXT=microk8s-kjeller deploy/apus/bygg.sh --rull-ut
#
# Left empty it uses whatever context is current, exactly as before.
KUBE_CONTEXT=${KUBE_CONTEXT:-}
KCTX=()
if [ -n "$KUBE_CONTEXT" ]; then
  KCTX=(--context "$KUBE_CONTEXT")
  echo "Klynge: $KUBE_CONTEXT"
fi
kubectl() { command kubectl ${KCTX[@]+"${KCTX[@]}"} "$@"; }

[ "${1:-}" = "--rull-ut" ] && RULL_UT=ja

cd "$(git rev-parse --show-toplevel)"
SHA=$(git rev-parse --short=12 HEAD)
if [ -n "$(git status --porcelain)" ]; then
  SHA="$SHA-skitten"
  echo "Advarsel: arbeidsmappen har ulagrede endringer. Merkes som $SHA."
fi
echo "Bygger $SHA"

# Git Bash på Windows gjør om /workspace til en Windows-sti i argumentlista til
# kubectl exec. MSYS_NO_PATHCONV=1 slår det av.
kexec() { MSYS_NO_PATHCONV=1 kubectl exec "$@"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kubectl -n "$NS_BYGG" delete pod epj-bygg-last --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

kubectl -n "$NS_BYGG" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $PVC
  namespace: $NS_BYGG
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: microk8s-hostpath
  resources:
    requests:
      storage: 6Gi
YAML

echo "→ starter mottakspod"
kubectl -n "$NS_BYGG" delete pod epj-bygg-last --ignore-not-found --wait=true >/dev/null
kubectl -n "$NS_BYGG" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: epj-bygg-last
  namespace: $NS_BYGG
spec:
  restartPolicy: Never
$( [ -n "$NODE" ] && printf '  nodeSelector:\n    kubernetes.io/hostname: %s\n' "$NODE" )
  containers:
    - name: last
      image: alpine:3.20
      command: ['sh', '-c', 'sleep 1800']
      volumeMounts: [{name: ws, mountPath: /workspace}]
      resources:
        requests: {cpu: 50m, memory: 64Mi}
        limits: {cpu: 200m, memory: 256Mi}
  volumes:
    - name: ws
      persistentVolumeClaim: {claimName: $PVC}
YAML
kubectl -n "$NS_BYGG" wait --for=condition=Ready pod/epj-bygg-last --timeout=180s >/dev/null

echo "→ overfører kildekoden"
# .dockerignore gjelder først inne i kaniko. Her tas det groveste bort, slik at
# overføringen ikke drar med seg node_modules og git-historikk.
git ls-files -z | tar --null -T - -cf "$TMP/kilde.tar"
kexec -i -n "$NS_BYGG" epj-bygg-last -- \
  sh -c 'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; cd /workspace && tar -xf -' < "$TMP/kilde.tar"
kubectl -n "$NS_BYGG" delete pod epj-bygg-last --wait=true >/dev/null

echo "→ bygger"
kubectl -n "$NS_BYGG" delete job epj-bygg --ignore-not-found --wait=true >/dev/null
kubectl -n "$NS_BYGG" apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: epj-bygg
  namespace: $NS_BYGG
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
$( [ -n "$NODE" ] && printf '      nodeSelector:\n        kubernetes.io/hostname: %s\n' "$NODE" )
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:v1.23.2
          args:
            - --context=dir:///workspace
            - --dockerfile=/workspace/docker/Dockerfile
            - --destination=$REGISTER_INN:$SHA
            - --destination=$REGISTER_INN:latest
            - --insecure
            - --skip-tls-verify
            # Uten disse to blir kaniko drept for minne på et node_modules av
            # denne størrelsen, like etter at bygget er ferdig.
            - --compressed-caching=false
            - --snapshot-mode=redo
          volumeMounts: [{name: ws, mountPath: /workspace}]
          resources:
            requests: {cpu: 500m, memory: 1Gi}
            limits: {cpu: '2', memory: 3584Mi}
      volumes:
        - name: ws
          persistentVolumeClaim: {claimName: $PVC}
YAML

until [ -n "$(kubectl -n "$NS_BYGG" get job epj-bygg -o jsonpath='{.status.succeeded}{.status.failed}' 2>/dev/null)" ]; do
  sleep 5
done

if [ "$(kubectl -n "$NS_BYGG" get job epj-bygg -o jsonpath='{.status.succeeded}')" != "1" ]; then
  echo "Bygget feilet:"
  kubectl -n "$NS_BYGG" logs job/epj-bygg --tail=40
  exit 1
fi

echo "✓ publisert $REGISTER_UT:$SHA"

if [ "$RULL_UT" = "ja" ]; then
  echo "→ ruller ut"
  # Merkelappen skrives inn i overlaget, ikke bare på deploymenten med
  # `kubectl set image`. To grunner:
  #
  #   * et senere `kubectl apply -k deploy/apus` ville ellers satt taggen
  #     tilbake til `latest`, og stilltiende rullet tilbake til et annet bilde
  #   * `latest` sammen med `imagePullPolicy: IfNotPresent` betyr at noden
  #     beholder det bildet den allerede har. Ny kode, gammelt bilde, ingen feil.
  #
  # Med commit-summen i kustomization.yaml er det som kjører til enhver tid
  # mulig å lese ut av git.
  sed -i.bak "s#^\( *newTag:\).*#\1 $SHA#" deploy/apus/kustomization.yaml
  rm -f deploy/apus/kustomization.yaml.bak
  kubectl apply -k deploy/apus
  kubectl -n "$NS_APP" rollout status deployment/epj --timeout=10m
  echo
  echo "deploy/apus/kustomization.yaml peker nå på $SHA. Husk å sjekke den inn."
fi
