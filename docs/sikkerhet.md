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
| Behandler | ja | ja | ja | ja | lege, sykepleier, jordmor, psykolog - alle som gir helsehjelp |
| Lab | begrenset | prøvesvar | nei | nei | Observation og DiagnosticReport |
| Resepsjon | begrenset | nei | nei | nei | time, oppgjør, pasientregistrering |
| Systemansvarlig | **nei** | nei | nei | nei | drift, brukere, apper og sikkerhetslogg |
| Pasient | egen journal | nei | nei | nei | innbygger |
| Systemeier | **nei** | nei | nei | nei | plattform, ingen virksomhet |

Rollene sier hva en bruker får se og gjøre, ikke hva hen er utdannet til.
Konsekvensen er at `behandler` kan forskrive selv om personen ikke er lege;
sperren for det må komme fra HPR-autorisasjonen på brukeren, ikke fra rollen
(se `docs/todo.md`).

At systemansvarlig ikke har klinisk innsyn er et poeng, ikke en forglemmelse.
Den som drifter systemet trenger ikke å lese journaler, og bør derfor ikke kunne
det. Det samme gjelder systemeier, som administrerer virksomhetene på
plattformen: rollen har ingen scopes i det hele tatt, så FHIR-fasaden avviser
den uansett hva den skulle spørre om.

Rettigheten `journal:utlever` styrer hvem som kan lage en journalutskrift. Den
er gitt til `behandler`, `resepsjon` og pasienten selv. Utleveringen henter innholdet gjennom den samme vokteren som
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
reserveløsning, og styres av `EPJ_TEST_LOGIN`. Den bør være av i produksjon.

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

## Sikkerhetsgjennomgang mot OWASP Top 10

Gjennomgått september 2026, med OWASP Top 10 (2021) som sjekkliste. Ni funn ble
rettet. De to første er de alvorlige; resten er herding.

### A01 Broken Access Control - vedlegg og grupper uten pasienttilknytning

`Binary` og `Group` var oppført som støttede ressurstyper i `/fhir`, men ingen
av dem har `subject` eller `patient`. Følgen var at
`pasientIdFraRessurs()` ga `null`, og `vurder()` behandlet «ingen kjent
pasient» som «ingen grunn til å nekte»:

```
if (!pasientId) return { tillatt: true, ... }
```

Det var en fail-open. For et enkeltoppslag betydde det at både tjenstlig behov
(lag 3) og sperring (lag 4) ble hoppet over. `Binary` bærer vedleggene -
skannede dokumenter, prøvesvar, bilder - og en `Group` er et kohortuttrekk der
selve medlemskapet kan være den følsomme opplysningen.

Det samme slo ut i søk: `sokRessurser()` tvinger inn et `patient=`-filter, men
bare når typen *har* et parameter å filtrere på. For `Binary` fantes ikke det,
og søket gikk ufiltrert videre til HAPI.

Utnyttbart for en registrert backend-tjeneste med `system/Binary.rs`, siden
`client_credentials` gir de scopene klienten er registrert med. Rollene i
journalen gir ingen av delene, så den vanlige innloggingen nådde ikke hit.

Rettet i tre lag:

1. `vurder()` nekter nå typer der pasienten ikke kan avgjøres, og nekter
   enkeltoppslag der referansen mangler. Søk slipper fortsatt gjennom, fordi de
   avgrenses per treff.
2. `sokRessurser()` avviser søk som ikke kan avgrenses, i stedet for å sende dem
   videre uten filter.
3. `Binary` og `Group` er tatt ut av de støttede typene. Skal vedlegg
   eksponeres, må pasienten utledes fra den `DocumentReference` som peker på
   dem.

Punkt 1 er en strukturell sperre, ikke en liste: en ny ressurstype uten
pasientreferanse blir avvist inntil noen har tatt stilling til den. En test i
`tests/tilgang.test.ts` går gjennom alle støttede typer og feiler hvis noen
slipper unna.

### A10 SSRF - `jwks_uri` på registrerte apper

Adressene til HelseID, SFM, NHN og Helfo settes av den som drifter systemet.
`jwks_uri` er noe annet: den kommer fra et skjemafelt når en app registreres, og
ble hentet med `fetch()` uten kontroll. Journalen kunne dermed brukes til å
hente adresser bare den selv når - HAPI, databasen, API-tjeneren, eller
metadatatjenesten til skyleverandøren på 169.254.169.254.

`src/lib/server/util/utgaende.ts` krever nå https, avviser navn og adresser som
peker inn i private eller lenkelokale nett, følger ikke omdirigeringer, og
leser ikke mer enn 512 kB.

### De øvrige funnene

| | Funn | Rettet ved |
| --- | --- | --- |
| A07 | Feil engangskode telte ikke mot utestengelse. Den som allerede hadde passordet kunne gjette TOTP fritt | Både passord og engangskode teller nå likt |
| A07 | `X-Forwarded-For` ble brukt selv når kjeden var kortere enn antall betrodde hopp - klienten kunne velge sin egen adresse, og både ratebegrensning per IP og `source_ip` i loggen ble verdiløs | Headeren ignoreres når kjeden er for kort |
| A07 | En `client_assertion` uten `exp` var gyldig for alltid | `exp` er påkrevd, med maks én times levetid |
| A07 | Feil prosentkoding i en Basic-header ga 500 i stedet for 401 | Fanges og gir 401 |
| A02 | Sesjonstokenets hash ble sammenliknet med `!==` | `timingSafeEqual` |
| A04 | `scryptSync` ble kjørt på nytt ved hvert sesjonsoppslag, altså ved hver forespørsel. Ratebegrensningen på 600 kall i minuttet ble dermed en oppskrift på å spise CPU-en | Nøkkelen utledes én gang og bufres på verdien den kommer fra |

### Gjennomgått uten funn

* **A03 Injection.** All SQL er parametrisert; det ene stedet som bygger en
  `WHERE` dynamisk (`hentLogg`) setter sammen faste fragmenter med
  posisjonsparametere. XML-parseren i `util/xml.ts` støtter ikke DTD eller egne
  entiteter, og har dybdegrense - hverken XXE eller entitetsutvidelse er mulig.
  Journalutskriften escaper alle felter, og serveres som `attachment`.
* **A02 Kryptografi.** AES-256-GCM med tilfeldig IV, scrypt for passord,
  ES256 for tokens. JWS-verifiseringen har en tillatelsesliste for `alg`, så
  «none» og bytte til HMAC er utelukket.
* **A05 Feilkonfigurasjon.** CSP settes av rammeverket med nonce, cookies er
  HttpOnly/SameSite=Strict/Secure, HSTS er på når `EPJ_HTTPS_ONLY` er satt,
  feilmeldinger til klienten røper ikke interne detaljer.
* **A07 Autentisering.** PKCE S256 er påkrevd, `redirect_uri` sammenliknes
  eksakt, autorisasjonskoder er engangsbruk med tilbakekalling ved gjenbruk,
  refresh tokens roteres med tyverideteksjon.

### Kjent, ikke rettet

* En TOTP-kode kan brukes om igjen innenfor sitt eget vindu på om lag 90
  sekunder. Å hindre det krever at brukte koder lagres per bruker.
* `total` i et søkeresultat trekker fra det som ble filtrert bort på siden man
  ser, men røper fortsatt at det finnes flere treff. En pasient med sperret
  journal kan dermed anes i et tall.
* `avsluttSesjon()` avslutter sesjonen ut fra id-en i cookien uten å
  kontrollere tokenet. Den som kjenner en sesjons-id kan logge ut den sesjonen.
* Systemet er fortsatt ikke penetrasjonstestet av noen utenfra. En gjennomgang
  av egen kode finner ikke det samme som et angrep gjør.

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
