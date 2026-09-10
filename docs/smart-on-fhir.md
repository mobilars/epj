# SMART on FHIR

Journalen er vert for SMART-apper etter SMART App Launch, slik Helsedirektoratet
anbefaler i HITR 1225. Både **EHR launch** (appen startes fra journalen med
pasienten i kontekst) og **standalone launch** støttes.

## Norske implementasjonsguider

Implementasjonen følger **HL7 SMART App Launch 2.2.0**. To norske dokumenter
bygger på den og er relevante:

* **«Implementasjonsguide SMART App Launch Framework»** fra Helsenorge
  (`helsenorge.atlassian.net`), som beskriver hvordan rammeverket brukes mot
  Helsenorge-plattformen.
* **HL7 Norges anbefaling** om SMART App Launch.

> **Ikke gjennomgått punkt for punkt.** Begge dokumentene var utilgjengelige
> gjennom utviklingsmiljøets nettverkspolicy. Hovedpunktene som lot seg lese ut
> av søketreffene stemmer med det som er bygget her: obligatorisk `launch`-scope
> sammen med `launch`-parameteren ved EHR launch, `openid` og `fhirUser` for
> identitet, og `id_token` utstedt sammen med access token. Guidene må likevel
> gjennomgås i sin helhet før produksjon; det står også i
> [åpne punkter](apne-punkter.md).

Der de norske guidene stiller krav utover HL7-spesifikasjonen, vil det gjelde
`auth/oauth.ts` (autorisasjonsflyten), `auth/tokens.ts` (påstandene i tokenet)
og `.well-known/smart-configuration`. Tilgangsmodellen berøres ikke: den
avgjøres av rolle og tjenstlig behov, ikke av hvilken guide appen følger.

## Slik kobles en app til

### 1. Appen registreres

Systemansvarlig registrerer appen under **Administrasjon → SMART-apper** med:

* navn og klienttype (offentlig med PKCE, eller konfidensiell),
* redirect-URI-er — sammenliknes eksakt,
* launch-URL for EHR launch,
* hvilke scope appen maksimalt kan få,
* referanse til databehandleravtalen.

Uten registrering kommer appen ikke inn. Mangler databehandleravtale, varsles
brukeren i samtykkedialogen.

### 2. Appen finner endepunktene

Metadataene er **per virksomhet**: `issuer` og endepunktene er virksomhetens
egne adresser, og signeringsnøklene i `jwks_uri` er virksomhetens egne. En app
som skal brukes ved flere legekontorer må hente dokumentet fra hvert av dem.

```
GET https://legekontoret-a.example.no/.well-known/smart-configuration
```

```json
{
  "issuer": "https://legekontoret-a.example.no",
  "authorization_endpoint": "https://legekontoret-a.example.no/oauth/authorize",
  "token_endpoint": "https://legekontoret-a.example.no/oauth/token",
  "jwks_uri": "https://legekontoret-a.example.no/oauth/jwks",
  "code_challenge_methods_supported": ["S256"],
  "capabilities": [
    "launch-ehr", "launch-standalone", "client-public",
    "client-confidential-symmetric", "client-confidential-asymmetric",
    "sso-openid-connect", "context-banner", "context-style",
    "context-ehr-patient", "context-ehr-encounter",
    "permission-patient", "permission-user", "permission-v1", "permission-v2",
    "permission-offline", "permission-online", "authorize-post"
  ]
}
```

### 3. EHR launch

Klinikeren åpner **Apper** i pasientens journal og starter appen. Journalen
lager en kortlivet, engangs launch-kontekst og sender brukeren til appens
launch-URL:

```
https://app.example/launch?iss=https://legekontoret-a.example.no/fhir&launch=<launch-id>
```

Appen henter oppsettet fra `iss` og starter autorisasjonen. Med flere
virksomheter peker `iss` på virksomheten appen ble startet fra, og
partisjonsnavnet inngår ikke i adressen - fasaden gjør oversettelsen mot HAPI
selv, slik at appen aldri trenger å vite hvilken partisjon den snakker med.

### 4. Autorisasjon

```
GET /oauth/authorize
  ?response_type=code
  &client_id=epj-…
  &redirect_uri=https://app.example/callback
  &scope=openid fhirUser launch launch/patient patient/Patient.rs patient/Observation.rs
  &state=<tilfeldig>
  &aud=https://legekontoret-a.example.no/fhir
  &launch=<launch-id>
  &code_challenge=<S256 av code_verifier>
  &code_challenge_method=S256
```

Brukeren får en samtykkedialog på norsk som viser hvilken app som spør, hvilken
pasient tilgangen gjelder, hva appen får gjøre, og hva som er avvist fordi
rollen ikke tillater det.

Ved godkjenning:

```
302 https://app.example/callback?code=<kode>&state=<samme state>
```

Ved avslag:

```
302 https://app.example/callback?error=access_denied&state=<samme state>
```

### 5. Innbytte av kode

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<kode>
&redirect_uri=https://app.example/callback
&client_id=epj-…
&code_verifier=<verifier>
```

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "openid fhirUser launch/patient patient/Patient.rs patient/Observation.rs",
  "patient": "8a07315c-…",
  "fhirUser": "https://legekontoret-a.example.no/fhir/Practitioner/42",
  "need_patient_banner": false,
  "smart_style_url": "https://legekontoret-a.example.no/smart-style.json",
  "id_token": "…"
}
```

Access tokenet bærer i tillegg en `tenant`-påstand. Den valideres mot
virksomheten forespørselen kommer inn på, så et token utstedt ved ett legekontor
kan ikke brukes ved et annet.

### 6. Kall mot FHIR

```
POST /fhir/Observation/_search
Authorization: Bearer …
Content-Type: application/x-www-form-urlencoded

patient=Patient/8a07315c-…&category=vital-signs
```

## Hva appen ikke får

Dette er testet, ikke bare tilsiktet:

* **Ressurstyper utenfor scopet.** `patient/Observation.rs` gir ikke diagnoser.
  Svaret er `403`.
* **Andre pasienter enn den i launch-konteksten.** `patient/`-scope bindes til
  `launch`-pasienten; oppslag på en annen pasient gir `403`.
* **Mer enn brukeren har.** Scope snevres inn mot brukerens rolle. Ber appen om
  noe rollen ikke har, faller det bort — også om brukeren trykker «Gi tilgang».
* **Tilgang uten tjenstlig behov.** Appen arver brukerens behandlingsrelasjoner.
* **Sperrede opplysninger.** Sperring gjelder også appen.
* **Tilgang etter sperring av appen.** Sperres appen, trekkes alle dens tokens
  tilbake umiddelbart.

Alle kall fra appen loggføres med appens `client_id` og brukerens identitet, og
vises i pasientens innsynslogg.

## Standalone launch

Uten `launch`-parameter starter appen selv, og brukeren logger inn i journalen
underveis. Pasientkontekst må da velges eksplisitt; en app som ber om
`patient/`-scope uten pasient i kontekst får avslag på kallene.

## Tjeneste-til-tjeneste

For integrasjoner uten bruker — datauttrekk, kvalitetsregistre — brukes SMART
Backend Services:

* `client_credentials` med `private_key_jwt` (ingen delt hemmelighet),
* bare `system/`-scope,
* `jti` kan ikke gjenbrukes,
* aldri pasientkontekst.

```
POST /oauth/token
grant_type=client_credentials
&scope=system/Observation.rs
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion=<JWT>
```

## Utseende

Apper som støtter `context-style` kan hente `smart_style_url` og tilpasse seg
journalens farger, slik at de ikke føles som et fremmedelement midt i en
konsultasjon.

## Feilsøking

| Symptom | Sannsynlig årsak |
| --- | --- |
| `unauthorized_client` på autorisasjon | `client_id` ukjent eller appen sperret |
| `invalid_request: redirect_uri er ikke registrert` | URI-en må stemme eksakt, inkludert skråstrek på slutten |
| `invalid_request: PKCE (code_challenge) er påkrevd` | PKCE er obligatorisk, også for konfidensielle klienter |
| `invalid_grant: PKCE-verifisering feilet` | `code_verifier` stemmer ikke med `code_challenge` |
| `invalid_grant: Autorisasjonskoden er allerede brukt` | Koden er engangs — alle tokens er nå trukket tilbake |
| Samtykkedialogen viser tilganger som «ikke tillatt» | Brukerens rolle dekker dem ikke |
| `403` på et kall appen har scope for | Brukeren mangler behandlingsrelasjon, eller pasienten har sperret |
