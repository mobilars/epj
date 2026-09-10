# Sikkerhet og personvern

## Tilgangsmodellen

Fire lag må alle gi grønt lys før en forespørsel slipper gjennom. De ligger i
`src/lib/server/authz/tilgang.ts`, og de er uavhengige: et hull i ett lag lukkes
av de andre.

| Lag | Spørsmål | Kilde |
| --- | --- | --- |
| 1. Scope | Hva har appen bedt om og fått? | SMART on FHIR |
| 2. Rolle | Hva kan denne stillingskategorien gjøre? | EPJ-standarden |
| 3. Tjenstlig behov | Har brukeren en behandlingsrelasjon til *denne* pasienten? | Helsepersonelloven § 21 a |
| 4. Sperring | Har pasienten sperret opplysningene for denne brukeren? | Pasientjournalloven |

Nødrett kan overstyre lag 3 og 4. Aldri lag 1 og 2: en app uten scope for
diagnoser får ikke diagnoser, uansett hvor akutt situasjonen er.

### Rollene

| Rolle | Klinisk innsyn | Skriver journal | Forskriver | Nødrett | Merknad |
| --- | --- | --- | --- | --- | --- |
| Lege | ja | ja | ja | ja | fullt behandleransvar |
| Vikarlege | ja | ja | ja | ja | tidsavgrenset |
| Turnuslege | ja | ja | ja | ja | kan kreve kontrasignering |
| Sykepleier | ja | ja | nei | ja | |
| Helsesekretær | begrenset | nei | nei | nei | time, oppgjør, administrasjon |
| Bioingeniør | begrenset | prøvesvar | nei | nei | |
| Jordmor | ja | ja | nei | ja | |
| Psykolog | ja | ja | nei | ja | |
| Systemansvarlig | **nei** | nei | nei | nei | drift, ikke klinikk |
| Personvernombud | nei | nei | nei | nei | logg og samtykker, alle pasienter |
| Regnskap | nei | nei | nei | nei | oppgjør |
| Pasient | egen journal | nei | nei | nei | innbygger |
| Systemeier | **nei** | nei | nei | nei | plattform, ingen virksomhet |

At systemansvarlig ikke har klinisk innsyn er et poeng, ikke en forglemmelse.
Den som drifter systemet trenger ikke å lese journaler, og bør derfor ikke kunne
det. Det samme gjelder systemeier, som administrerer virksomhetene på
plattformen: rollen har ingen scopes i det hele tatt, så FHIR-fasaden avviser
den uansett hva den skulle spørre om.

Rettigheten `journal:utlever` styrer hvem som kan lage en journalutskrift. Den
er gitt til lege, vikarlege, jordmor, psykolog, helsesekretær, personvernombud
og pasienten selv. Utleveringen henter innholdet gjennom den samme vokteren som
alt annet, så den gir aldri mer enn den som utleverer selv har tilgang til.

### Tjenstlig behov

En behandlingsrelasjon registreres i `care_relationship` med et grunnlag
(fastlege, konsultasjon, vikar, henvisning, administrativ) og en gyldighets-
periode. Uten en gyldig relasjon:

* vises ikke pasienten i søk — avgrensningen legges inn i selve FHIR-spørringen,
* gir oppslag på ressurs-id 403, og
* forsøket loggføres.

### Sperring

Pasienten kan sperre journalen mot en navngitt bruker, mot en rolle, mot alle,
eller mot et enkelt dokument. Sperringen håndheves både ved direkte oppslag og
som etterfilter på søkeresultater — sperringen kan endres mellom to kall, og
FHIR-serveren kjenner ikke modellen.

### Nødrett

Nødrettstilgang krever:

* begrunnelse på minst 15 tegn, kontrollert både i nettleseren og på serveren,
* ny bekreftelse av engangskode (step-up),
* en rolle som har lov til det.

Tilgangen varer fire timer, kan avsluttes manuelt, merker pasientbanneret rødt,
og gir et `AuditEvent` med `purposeOfUse = ETREAT`. Oppslaget står på
systemansvarliges oversikt til det er gjennomgått.

## Autentisering

**HelseID** er primærmekanismen: OIDC med autorisasjonskode, PKCE og
`private_key_jwt`. Sikkerhetsnivå 4 kreves. Brukere kobles på `sub`, sekundært
på HPR-nummer, og opprettes uten roller — tilgang er alltid en administrativ
handling som etterlater spor.

**Lokal pålogging** med brukernavn, passord og TOTP finnes for testmiljø og som
reserveløsning, og styres av `EPJ_TESTINNLOGGING`. Den bør være av i produksjon.

* Passord: scrypt (N=16384, r=8, p=1) med tilfeldig salt.
* Engangskode: TOTP etter RFC 6238, hemmelighet kryptert med AES-256-GCM.
* Fem feilforsøk låser kontoen midlertidig.
* Feilmeldingen er lik for ukjent bruker og feil passord.
* Sesjon: HttpOnly, SameSite=Strict, Secure; 30 min inaktiv, 12 timer absolutt.
* Feil token på en gyldig sesjons-id avslutter sesjonen — det er et tegn på at
  cookien er på avveie.

## API-sikkerhet

* **OAuth 2.1.** PKCE med S256 er påkrevd for alle klienter, også
  konfidensielle. `redirect_uri` sammenliknes eksakt, uten mønstertolkning.
* **Autorisasjonskoden er engangs.** Gjenbruk trekker tilbake alt som er utstedt
  til klienten for brukeren.
* **Refresh tokens roteres.** Gjenbruk av et innbyttet token trekker tilbake
  hele familien.
* **Tokens kan trekkes tilbake.** Access tokens er signerte JWT-er, men hashen
  lagres, slik at tilgang kan stanses umiddelbart — for eksempel når et
  arbeidsforhold avsluttes.
* **`alg` er på tillatelsesliste.** `none` og bytte til HMAC med den offentlige
  nøkkelen som hemmelighet er utelukket.
* **Nøkler roteres**, og gamle nøkler blir i JWKS til utstedte tokens er utløpt.
* **Backend-tjenester** må bruke `private_key_jwt` og får bare `system/`-scope.
  `jti` kan ikke gjenbrukes.

## Sikkerhetslogg

Hvert kall gir et FHIR `AuditEvent` med hvem, hva, når, hvilken pasient, hvilken
app, fra hvilken adresse og med hvilket formål. Avviste forsøk logges også.

Loggen er beskyttet i to lag:

1. **Databasen avviser `UPDATE` og `DELETE`** med en trigger. En feil i
   applikasjonen kan ikke endre historikken.
2. **Radene er lenket med SHA-256.** Hver rad binder seg til forrige rads hash.
   Fjerning eller endring bryter kjeden, og `verifiserLoggkjede()` finner det.
   Administrasjonssiden viser tilstanden.

Søkestrenger maskeres før de lagres: en logg som inneholder fødselsnumrene noen
har søkt på, er selv blitt et personregister.

## Applikasjonssikkerhet

* **Innholdssikkerhetspolicy** settes av SvelteKit med nonce på rammeverkets
  egne skript. `default-src 'self'`, ingen tredjeparts skript, `object-src
  'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
* **HSTS** utenfor lokal utvikling, sammen med `nosniff`, `no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin` og en restriktiv
  `permissions-policy`.
* **CORS** for `/fhir` åpnes bare for opphavene til registrerte, aktive apper.
* **Ratebegrensning** per IP og per brukernavn, delt mellom appinstanser
  gjennom databasen.
* **Parametriserte spørringer** overalt. Ingen brukerdata settes inn i SQL som
  tekst.
* **Feilmeldinger** lekker ikke interne detaljer; klienten får en
  korrelasjons-id som finnes igjen i serverloggen.
* **Åpen viderekobling** er utelukket: retur-URL-er må være interne stier, og
  ukjent `redirect_uri` gir feilside i stedet for omdirigering.

## Trusselvurdering

| Trussel | Tiltak |
| --- | --- |
| Nysgjerrighetsoppslag på kjendis, nabo eller familie | Tjenstlig behov kreves; søk avgrenses; nødrett krever begrunnelse og gjennomgås |
| Ansatt som slutter, men beholder tilgang | Deaktivering avslutter sesjoner og trekker tilbake alle tokens |
| Stjålet sesjonscookie | HttpOnly, SameSite=Strict, Secure; feil token avslutter sesjonen; inaktivitetsgrense |
| Stjålet access token | Kort levetid, hash lagret slik at det kan trekkes tilbake, bundet til klient |
| App som ber om for mye | Scope snevres inn mot både klientregistrering og brukerens rolle |
| App som prøver seg på en annen pasient | `patient/`-scope bindes til launch-konteksten |
| Kompromittert app | Sperring trekker tilbake alle appens tokens umiddelbart |
| Manipulering av loggen | Append-only i databasen, og hash-lenke som avslører endring |
| Angriper som omgår nettleserkontroller | All validering gjentas på serveren; testet eksplisitt |
| Forsyningskjedeangrep | Én runtime-avhengighet; kryptografi mot standardbiblioteket |
| Passordgjetting | Utestengelse, ratebegrensning per konto og per adresse, TOTP |
| Tokentyveri ved gjenbruk av kode | Engangs autorisasjonskode; gjenbruk trekker tilbake alt |

## Forholdet til Normen

Normen for informasjonssikkerhet og personvern i helse- og omsorgssektoren
stiller krav til virksomheten, ikke bare til programvaren. Tabellen viser hva
systemet bidrar med, og hva virksomheten fortsatt må gjøre.

| Kravområde i Normen | Hva systemet gjør | Hva virksomheten må gjøre |
| --- | --- | --- |
| Tilgangsstyring | Rolle, tjenstlig behov, sperring, nødrett | Tildele roller, følge opp autorisasjonsregister |
| Autentisering | HelseID på nivå 4, TOTP, utestengelse | Bestemme om lokal pålogging skal være aktiv |
| Logging og oppfølging | Uforanderlig logg, gjennomgangskø for nødrett | Faktisk gjennomgå loggen, og dokumentere det |
| Den registrertes rettigheter | Innsynslogg per pasient, retting, sperring | Behandle henvendelser innen frist |
| Databehandlere | Register over apper med avtalereferanse | Inngå og følge opp avtalene |
| Risikostyring | Trusselvurdering over, sikker standardoppsett | Egen risikovurdering og personvernkonsekvensvurdering |
| Kommunikasjon over åpne nett | TLS, HSTS, ingen tredjeparts skript | Sertifikater, brannmur, Helsenett-tilkobling |
| Sikkerhetskopi og gjenoppretting | — | Sikkerhetskopi, testet gjenoppretting, oppbevaringstid |
| Avvikshåndtering | Loggintegritetskontroll, helsesjekk | Rutine for avvik og varsling til Datatilsynet |

## Skille mellom virksomheter

Én installasjon betjener flere legekontorer, og skillet mellom dem er en
sikkerhetsgrense på linje med skillet mellom pasienter.

Virksomheten utledes av **vertsnavnet**, aldri av noe klienten kan velge -
verken en parameter, en header eller et felt i tokenet. Access tokens bærer en
`tenant`-påstand som valideres mot forespørselens virksomhet, slik at et token
utstedt i én virksomhet ikke kan brukes i en annen selv om nøkkelen skulle
lekke.

| Det som skilles | Hvordan |
| --- | --- |
| Kliniske data | Egen partisjon i HAPI FHIR, referanser på tvers slått av |
| Brukere, roller, sesjoner | `tenant_id`, `NOT NULL`, per-virksomhet unike brukernavn |
| Sikkerhetslogg | Egen hash-kjede per virksomhet |
| OAuth-klienter og tokens | `tenant_id`; `tenant`-påstand i tokenet |
| Signeringsnøkler og `issuer` | Egne per virksomhet |
| Ratebegrensning | Virksomheten inngår i nøkkelen |

Suspensjon av en virksomhet virker umiddelbart: alle sesjoner avsluttes og alle
utstedte tokens trekkes tilbake i samme transaksjon. Kliniske data røres ikke.

Isolasjonen hviler på at all kode filtrerer på `tenant_id`, og på at
`krevTenant()` kaster når konteksten mangler. Det er testet - 32 tester i
`tests/multitenancy.test.ts` skriver data i én virksomhet gjennom de samme
modulene applikasjonen bruker, og kontrollerer at de er usynlige fra en annen -
men det er fortsatt disiplin, ikke en garanti fra databasen. Se
[arkitektur.md](arkitektur.md) for hvorfor Row Level Security ble valgt bort, og
[todo.md](todo.md) punkt 4.7.

## Kjente svakheter

Ærlig oppsummert, og utdypet i [åpne punkter](apne-punkter.md):

* Automatisk sletting av logg etter oppbevaringstiden er ikke implementert.
* Sikkerhetsloggen er append-only i databasen og hash-lenket, men en som får
  kontroll over databasen kan fjerne triggeren. Kjeden gjør at det *oppdages*,
  ikke at det *forhindres*. Utlevering til et eksternt, skrivebeskyttet arkiv er
  ikke bygget.
* Endelig sletting etter helsepersonelloven § 43 er bevisst ikke eksponert i
  grensesnittet, og mangler dermed en vedtaksflyt.
* Virksomhetsisolasjonen håndheves av applikasjonen, ikke av databasen.
* Systemet er ikke penetrasjonstestet.
* Interaksjonsdatabasen i SFM-simulatoren er et lite utvalg, ikke en klinisk kilde.
* Takstbeløpene er et arbeidsgrunnlag og må oppdateres fra normaltariffen.
* Enkelte kodeverks-OID-er er ikke verifisert mot Volven.
* HelseID-integrasjonen er implementert etter spesifikasjonen, men ikke kjørt
  mot NHN sitt testmiljø.
