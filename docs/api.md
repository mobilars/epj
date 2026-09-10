# API

Journalen eksponerer to API-flater:

* **`/fhir`** — FHIR R5 for alle kliniske data. `application/fhir+json`.
* **`/oauth`** — OAuth 2.1 / SMART on FHIR for autentisering og autorisasjon.

All funksjonalitet er tilgjengelig gjennom API-et. Meldinger, resepter og
oppgjør er speilet som FHIR-ressurser, slik at ingenting bare finnes i
grensesnittet.

## Autentisering

Alle kall mot `/fhir` krever `Authorization: Bearer <token>`, eller en gyldig
sesjon i journalens eget grensesnitt.

```
GET /fhir/Patient/123
Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6…
Accept: application/fhir+json
```

Uten gyldig token:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="https://epj.example", error="invalid_token"
Content-Type: application/fhir+json

{"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"login",
 "diagnostics":"Ugyldig eller utløpt token"}]}
```

## Oppsettdokumenter

| Endepunkt | Innhold |
| --- | --- |
| `GET /.well-known/smart-configuration` | SMART-egenskaper, endepunkter, scope |
| `GET /.well-known/openid-configuration` | OpenID Connect-metadata |
| `GET /oauth/jwks` | Offentlige nøkler for å verifisere tokens |
| `GET /fhir/metadata` | CapabilityStatement med SMART-utvidelsen |
| `GET /smart-style.json` | Fargepalett apper kan tilpasse seg |
| `GET /api/helse` | Helsesjekk for overvåking |

## FHIR-endepunktet

### Operasjoner

| Metode og sti | Handling |
| --- | --- |
| `GET [type]/[id]` | Les ressurs |
| `GET [type]/[id]/_history` | Versjonshistorikk |
| `GET [type]/[id]/_history/[versjon]` | Les bestemt versjon |
| `POST [type]/_search` | Søk (foretrukket) |
| `GET [type]?…` | Søk med spørrestreng |
| `POST [type]` | Opprett |
| `PUT [type]/[id]` | Oppdater |
| `PATCH [type]/[id]` | JSON Patch |
| `DELETE [type]/[id]` | Fjern fra søk; versjonene beholdes |
| `POST /fhir` | Transaksjon eller batch |
| `GET Patient/[id]/$everything` | Pasientens samlede journal |
| `POST [type]/$validate` | Valider uten å lagre |

**Bruk `POST [type]/_search`.** Fødselsnummer i en URL havner i proxy-logger,
nettleserhistorikk og feilrapporter:

```
POST /fhir/Patient/_search
Authorization: Bearer …
Content-Type: application/x-www-form-urlencoded

identifier=urn:oid:2.16.578.1.12.4.1.4.1|13086510035
```

### Støttede ressurstyper

`Patient`, `Practitioner`, `PractitionerRole`, `Organization`, `Location`,
`Encounter`, `Condition`, `Observation`, `MedicationRequest`,
`MedicationStatement`, `MedicationDispense`, `Medication`,
`AllergyIntolerance`, `Immunization`, `Procedure`, `DiagnosticReport`,
`ServiceRequest`, `DocumentReference`, `Composition`, `CarePlan`, `Goal`,
`Appointment`, `Schedule`, `Slot`, `Communication`, `CommunicationRequest`,
`Task`, `Consent`, `Coverage`, `Claim`, `ClaimResponse`, `ChargeItem`,
`Invoice`, `RelatedPerson`, `Questionnaire`, `QuestionnaireResponse`, `Flag`,
`FamilyMemberHistory`, `RiskAssessment`, `List`, `Group`, `AuditEvent`,
`Provenance`, `Binary`, `Subscription`.

### Norske identifikatorsystemer

| System | OID |
| --- | --- |
| Fødselsnummer | `urn:oid:2.16.578.1.12.4.1.4.1` |
| D-nummer | `urn:oid:2.16.578.1.12.4.1.4.2` |
| HPR-nummer | `urn:oid:2.16.578.1.12.4.1.4.4` |
| Organisasjonsnummer | `urn:oid:2.16.578.1.12.4.1.4.101` |
| HER-id | `urn:oid:2.16.578.1.12.4.1.2` |
| ICPC-2 | `urn:oid:2.16.578.1.12.4.1.1.7170` |
| ICD-10 | `urn:oid:2.16.578.1.12.4.1.1.7110` |
| ATC | `urn:oid:2.16.578.1.12.4.1.1.7180` |

Fødselsnummer, D-nummer og organisasjonsnummer valideres med mod11 før lagring.
Ugyldige numre avvises med `422` og et `OperationOutcome` som peker på feltet.

### Feilkoder

| Status | Betyr |
| --- | --- |
| `400` | Ugyldig forespørsel |
| `401` | Mangler, ugyldig eller tilbakekalt token |
| `403` | Autentisert, men ikke tillatt — scope, rolle, tjenstlig behov eller sperring |
| `404` | Ressursen finnes ikke |
| `409` | Konflikt, f.eks. flere treff på betinget operasjon |
| `410` | Ressursen er slettet |
| `412` | Versjonskonflikt (`If-Match`) |
| `422` | Innholdet validerer ikke |
| `429` | For mange forespørsler |
| `503` | FHIR-serveren svarer ikke |

Alle feil returneres som `OperationOutcome`.

## OAuth 2.1

### Endepunkter

| Endepunkt | Beskrivelse |
| --- | --- |
| `GET /oauth/authorize` | Autorisasjon med samtykkedialog |
| `POST /oauth/token` | `authorization_code`, `refresh_token`, `client_credentials` |
| `POST /oauth/introspect` | RFC 7662, krever autentisert klient |
| `POST /oauth/revoke` | RFC 7009 |
| `GET /oauth/jwks` | Offentlige nøkler |

### Krav til klienter

* PKCE med `S256` er **påkrevd**, også for konfidensielle klienter.
* `redirect_uri` sammenliknes eksakt mot registreringen.
* `state` er påkrevd.
* `aud` må være FHIR-basen.
* Autorisasjonskoden er engangs og lever i 60 sekunder.
* Refresh tokens roteres; gjenbruk trekker tilbake hele familien.

### Scope

SMART-scope versjon 2, med versjon 1 tolket som versjon 2.

```
<kontekst>/<ResourceType>.<operasjoner>[?<begrensning>]

kontekst      patient | user | system
operasjoner   c(reate) r(ead) u(pdate) d(elete) s(earch), i denne rekkefølgen
```

| Eksempel | Betydning |
| --- | --- |
| `patient/Observation.rs` | Les og søk målinger for pasienten i launch-konteksten |
| `user/Condition.cruds` | Full tilgang til diagnoser for pasientene brukeren har relasjon til |
| `system/Patient.rs` | Tjeneste-til-tjeneste, uten bruker |
| `patient/Observation.rs?category=vital-signs` | Bare vitale målinger |

**Regler for innsnevring**

* En app får aldri mer enn den er registrert for.
* En app får aldri mer enn brukerens rolle tillater.
* `patient/X` dekkes av `user/X` — patient-varianten er en innsnevring til én
  pasient. Motsatt vei gjelder ikke.
* `system/` dekker ikke brukerscope, og gis bare til `client_credentials` med
  `private_key_jwt`.

Spesialscope: `openid`, `profile`, `fhirUser`, `email`, `launch`,
`launch/patient`, `launch/encounter`, `offline_access`, `online_access`.

### Tokensvar

```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIs…",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "openid fhirUser launch/patient patient/Patient.rs patient/Observation.rs",
  "refresh_token": "…",
  "id_token": "…",
  "patient": "8a07315c-fc67-4e19-9384-477db33034c1",
  "fhirUser": "https://epj.example/fhir/Practitioner/42",
  "need_patient_banner": false,
  "smart_style_url": "https://epj.example/smart-style.json"
}
```

Access tokens er ES256-signerte JWT-er med `typ: at+jwt`:

```json
{
  "iss": "https://epj.example",
  "sub": "<bruker-id>",
  "aud": "https://epj.example/fhir",
  "client_id": "epj-…",
  "scope": "…",
  "roles": ["lege"],
  "patient": "…",
  "fhirUser": "https://epj.example/fhir/Practitioner/42",
  "jti": "…", "iat": 1770000000, "exp": 1770000600
}
```

Ressursserveren verifiserer signaturen **og** slår opp tokenet, slik at det kan
trekkes tilbake.

## Tjeneste-til-tjeneste (SMART Backend Services)

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&scope=system/Patient.rs system/Observation.rs
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion=<JWT signert med klientens private nøkkel>
```

Klientassertionen må ha `iss` og `sub` lik `client_id`, `aud` lik
token-endepunktet, og en `jti` som ikke er brukt før. Bare `system/`-scope
utstedes; en backend-tjeneste får aldri pasientkontekst.

## Ratebegrensning

| Endepunkt | Standard |
| --- | --- |
| `/oauth/token`, `/logg-inn` | 20 per minutt per IP |
| Øvrige | 600 per minutt per IP |
| Pålogging per brukernavn | 10 per 5 minutter |

Ved overskridelse: `429` med `Retry-After`. Grensene settes med
`EPJ_RATE_AUTH`, `EPJ_RATE_GENERAL`, `EPJ_RATE_LOGIN_USER`.

## CORS

`/fhir` tillater opphavene til registrerte, aktive apper — utledet fra deres
redirect-URI-er. Ukjente opphav får ingen CORS-headere.
