-- ---------------------------------------------------------------------------
-- EPJ datamodell.
--
-- Kliniske data lagres som FHIR R5-ressurser i `resource` med en generisk
-- søkeindeks (`search_index`) og full versjonshistorikk (`resource_history`).
-- Journal er append-only: `resource_history` slettes aldri, slik at
-- pasientjournalforskriftens krav om at endringer skal kunne spores oppfylles.
-- ---------------------------------------------------------------------------

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Gjeldende versjon av hver ressurs.
CREATE TABLE IF NOT EXISTS resource (
  resource_type TEXT NOT NULL,
  id            TEXT NOT NULL,
  version_id    INTEGER NOT NULL,
  last_updated  TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  content       TEXT NOT NULL,
  PRIMARY KEY (resource_type, id)
);
CREATE INDEX IF NOT EXISTS idx_resource_updated ON resource (resource_type, last_updated);

-- Uforanderlig historikk. Én rad per versjon, inkludert sletting (DELETE).
CREATE TABLE IF NOT EXISTS resource_history (
  resource_type TEXT NOT NULL,
  id            TEXT NOT NULL,
  version_id    INTEGER NOT NULL,
  last_updated  TEXT NOT NULL,
  method        TEXT NOT NULL,              -- POST | PUT | PATCH | DELETE
  author_ref    TEXT,                       -- Practitioner/... eller Device/...
  author_navn   TEXT,
  content       TEXT,                       -- NULL for DELETE
  PRIMARY KEY (resource_type, id, version_id)
);

-- Generisk søkeindeks. Én rad per (ressurs, søkeparameter, verdi).
CREATE TABLE IF NOT EXISTS search_index (
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  param         TEXT NOT NULL,
  kind          TEXT NOT NULL,              -- string|token|reference|date|number|quantity|uri
  value_string  TEXT,                       -- normalisert (lowercase, uten diakritiske tegn)
  token_system  TEXT,
  token_code    TEXT,
  ref_type      TEXT,
  ref_id        TEXT,
  num_low       REAL,
  num_high      REAL,
  date_low      TEXT,
  date_high     TEXT
);
CREATE INDEX IF NOT EXISTS idx_si_token  ON search_index (resource_type, param, token_code, token_system);
CREATE INDEX IF NOT EXISTS idx_si_string ON search_index (resource_type, param, value_string);
CREATE INDEX IF NOT EXISTS idx_si_ref    ON search_index (resource_type, param, ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_si_date   ON search_index (resource_type, param, date_low, date_high);
CREATE INDEX IF NOT EXISTS idx_si_num    ON search_index (resource_type, param, num_low);
CREATE INDEX IF NOT EXISTS idx_si_res    ON search_index (resource_type, resource_id);

-- ---------------------------------------------------------------------------
-- Sikkerhetslogg. Hash-lenket slik at fjerning eller endring av rader
-- oppdages ved verifisering (EPJ-standard: loggen skal være uforanderlig).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_event (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded       TEXT NOT NULL,
  type_code      TEXT NOT NULL,             -- f.eks. rest, login, emergency-override
  subtype        TEXT,                      -- f.eks. read, search-type, vread
  action         TEXT NOT NULL,             -- C | R | U | D | E
  outcome        TEXT NOT NULL,             -- 0 (ok) | 4 | 8 | 12
  outcome_desc   TEXT,
  actor_user_id  TEXT,
  actor_ref      TEXT,
  actor_navn     TEXT,
  actor_rolle    TEXT,
  client_id      TEXT,
  source_ip      TEXT,
  patient_id     TEXT,                      -- pasienten opplysningene gjelder
  entity_ref     TEXT,
  purpose_of_use TEXT,                      -- TREAT | ETREAT (nødrett) | HOPERAT | ...
  request_id     TEXT,
  content        TEXT NOT NULL,             -- fullstendig FHIR AuditEvent (R5) som JSON
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_event (patient_id, recorded);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_event (actor_user_id, recorded);
CREATE INDEX IF NOT EXISTS idx_audit_time    ON audit_event (recorded);

-- ---------------------------------------------------------------------------
-- Brukere, roller og tilgangsstyring
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_account (
  id                   TEXT PRIMARY KEY,
  brukernavn           TEXT NOT NULL UNIQUE,
  navn                 TEXT NOT NULL,
  epost                TEXT,
  hpr_nummer           TEXT,                -- Helsepersonellregisteret
  practitioner_id      TEXT,                -- FHIR Practitioner.id
  passord_hash         TEXT,                -- NULL når kun HelseID brukes
  totp_secret_enc      TEXT,                -- kryptert med EPJ_DATA_KEY
  mfa_aktivert         INTEGER NOT NULL DEFAULT 0,
  helseid_sub          TEXT UNIQUE,
  status               TEXT NOT NULL DEFAULT 'aktiv',  -- aktiv | sperret | avsluttet
  ma_bytte_passord     INTEGER NOT NULL DEFAULT 0,
  feilede_forsok       INTEGER NOT NULL DEFAULT 0,
  laast_til            TEXT,
  siste_innlogging     TEXT,
  opprettet            TEXT NOT NULL,
  oppdatert            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_assignment (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  rolle         TEXT NOT NULL,              -- se authz/roles.ts
  gyldig_fra    TEXT NOT NULL,
  gyldig_til    TEXT,
  tildelt_av    TEXT,
  begrunnelse   TEXT
);
CREATE INDEX IF NOT EXISTS idx_role_user ON role_assignment (user_id);

-- Tjenstlig behov: dokumentert behandlingsrelasjon mellom bruker og pasient.
CREATE TABLE IF NOT EXISTS care_relationship (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  patient_id   TEXT NOT NULL,
  grunnlag     TEXT NOT NULL,               -- fastlege | konsultasjon | vikar | henvisning | administrativ
  gyldig_fra   TEXT NOT NULL,
  gyldig_til   TEXT,
  opprettet_av TEXT,
  UNIQUE (user_id, patient_id, grunnlag, gyldig_fra)
);
CREATE INDEX IF NOT EXISTS idx_care_user_patient ON care_relationship (user_id, patient_id);

-- Nødrettstilgang ("break the glass"). Alltid tidsbegrenset og alltid logget.
CREATE TABLE IF NOT EXISTS break_glass (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  patient_id   TEXT NOT NULL,
  begrunnelse  TEXT NOT NULL,
  startet      TEXT NOT NULL,
  utloper      TEXT NOT NULL,
  varslet      INTEGER NOT NULL DEFAULT 0,  -- pasienten skal informeres
  gjennomgatt_av TEXT,
  gjennomgatt_tid TEXT
);
CREATE INDEX IF NOT EXISTS idx_bg_user ON break_glass (user_id, patient_id, utloper);

-- Sperring av journal (pasientjournalloven § 17 / pasient- og brukerrettighetsloven).
-- Speiles som FHIR Consent-ressurs, men holdes her for rask håndheving.
CREATE TABLE IF NOT EXISTS journal_sperring (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL,
  omfang       TEXT NOT NULL,               -- alle | bruker | rolle | dokument
  mal_user_id  TEXT,
  mal_rolle    TEXT,
  mal_ressurs  TEXT,                        -- ResourceType/id
  begrunnelse  TEXT,
  registrert   TEXT NOT NULL,
  registrert_av TEXT NOT NULL,
  gyldig_til   TEXT,
  opphevet     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sperring_patient ON journal_sperring (patient_id, opphevet);

-- ---------------------------------------------------------------------------
-- OAuth 2.1 / SMART on FHIR
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_client (
  client_id        TEXT PRIMARY KEY,
  navn             TEXT NOT NULL,
  type             TEXT NOT NULL,           -- public | confidential
  klient_kategori  TEXT NOT NULL,           -- smart-ehr | smart-standalone | backend | internal
  secret_hash      TEXT,
  jwks             TEXT,                    -- for private_key_jwt (asymmetrisk klientauth)
  jwks_uri         TEXT,
  redirect_uris    TEXT NOT NULL DEFAULT '[]',
  tillatte_scopes  TEXT NOT NULL DEFAULT '[]',
  grant_types      TEXT NOT NULL DEFAULT '["authorization_code"]',
  krev_pkce        INTEGER NOT NULL DEFAULT 1,
  krev_samtykke    INTEGER NOT NULL DEFAULT 1,
  logo_url         TEXT,
  databehandleravtale TEXT,                 -- referanse til inngått avtale (Normen)
  status           TEXT NOT NULL DEFAULT 'aktiv',
  opprettet        TEXT NOT NULL,
  opprettet_av     TEXT
);

CREATE TABLE IF NOT EXISTS oauth_authorization_code (
  code_hash        TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  redirect_uri     TEXT NOT NULL,
  scope            TEXT NOT NULL,
  code_challenge   TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  nonce            TEXT,
  launch_context   TEXT NOT NULL DEFAULT '{}',
  utloper          TEXT NOT NULL,
  brukt            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_token (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,             -- access | refresh
  token_hash     TEXT NOT NULL UNIQUE,
  client_id      TEXT NOT NULL,
  user_id        TEXT,
  scope          TEXT NOT NULL,
  launch_context TEXT NOT NULL DEFAULT '{}',
  familie        TEXT NOT NULL,             -- refresh-token-familie for gjenbruksdeteksjon
  utstedt        TEXT NOT NULL,
  utloper        TEXT NOT NULL,
  tilbakekalt    INTEGER NOT NULL DEFAULT 0,
  tilbakekalt_grunn TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_family ON oauth_token (familie);
CREATE INDEX IF NOT EXISTS idx_token_user   ON oauth_token (user_id, kind);

-- Kortlivet SMART EHR-launch-kontekst opprettet av journalen før app åpnes.
CREATE TABLE IF NOT EXISTS smart_launch (
  launch_id    TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  patient_id   TEXT,
  encounter_id TEXT,
  intent       TEXT,
  opprettet    TEXT NOT NULL,
  utloper      TEXT NOT NULL,
  brukt        INTEGER NOT NULL DEFAULT 0
);

-- Signeringsnøkler for access tokens og dokumentsignering, med rotasjon.
CREATE TABLE IF NOT EXISTS signing_key (
  kid          TEXT PRIMARY KEY,
  alg          TEXT NOT NULL,
  public_jwk   TEXT NOT NULL,
  private_enc  TEXT NOT NULL,               -- PKCS#8, kryptert med EPJ_DATA_KEY
  opprettet    TEXT NOT NULL,
  aktiv        INTEGER NOT NULL DEFAULT 1,
  utfases_etter TEXT
);

CREATE TABLE IF NOT EXISTS user_session (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  opprettet      TEXT NOT NULL,
  sist_aktiv     TEXT NOT NULL,
  utloper        TEXT NOT NULL,
  ip             TEXT,
  user_agent     TEXT,
  amr            TEXT,                      -- pwd | pwd+otp | helseid
  elevert_til    TEXT,
  avsluttet      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket     TEXT PRIMARY KEY,
  teller     INTEGER NOT NULL,
  vindu_start INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Integrasjoner: NHN meldingstjener, SFM, Helfo
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS melding (
  id             TEXT PRIMARY KEY,
  retning        TEXT NOT NULL,             -- inn | ut
  meldingstype   TEXT NOT NULL,             -- henvisning | epikrise | dialogmelding | rekvisisjon | svarrapport | apprec
  msg_id         TEXT NOT NULL,             -- MsgId i hodemeldingen
  ref_msg_id     TEXT,
  patient_id     TEXT,
  avsender_her   TEXT,
  mottaker_her   TEXT,
  mottaker_navn  TEXT,
  status         TEXT NOT NULL,             -- kladd | kø | sendt | kvittert | avvist | feilet | mottatt | behandlet
  status_detalj  TEXT,
  apprec_status  TEXT,                      -- 1 ok | 2 ok med merknad | 3 avvist
  forsok         INTEGER NOT NULL DEFAULT 0,
  neste_forsok   TEXT,
  payload_xml    TEXT,
  ebxml          TEXT,
  opprettet      TEXT NOT NULL,
  oppdatert      TEXT NOT NULL,
  opprettet_av   TEXT,
  signatur       TEXT
);
CREATE INDEX IF NOT EXISTS idx_melding_status ON melding (status, neste_forsok);
CREATE INDEX IF NOT EXISTS idx_melding_pasient ON melding (patient_id, opprettet);

CREATE TABLE IF NOT EXISTS sfm_synk (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL,
  operasjon     TEXT NOT NULL,              -- hentLegemiddelliste | forskriv | seponer | fornye | utleveringsrapport
  status        TEXT NOT NULL,              -- kø | sendt | ok | feilet
  forespørsel   TEXT,
  svar          TEXT,
  feilmelding   TEXT,
  reseptid      TEXT,
  opprettet     TEXT NOT NULL,
  oppdatert     TEXT NOT NULL,
  utført_av     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sfm_pasient ON sfm_synk (patient_id, opprettet);

-- Regningskort til Helfo/KUHR (oppgjør) med tilhørende takstlinjer.
CREATE TABLE IF NOT EXISTS regningskort (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  encounter_id   TEXT,
  behandler_id   TEXT NOT NULL,
  hpr_nummer     TEXT,
  dato           TEXT NOT NULL,
  kontakttype    TEXT NOT NULL,             -- kontor | sykebesok | e-konsultasjon | telefon | enkel
  diagnose_kode  TEXT,
  diagnose_system TEXT,
  refusjon_ore   INTEGER NOT NULL DEFAULT 0,
  egenandel_ore  INTEGER NOT NULL DEFAULT 0,
  frikort        INTEGER NOT NULL DEFAULT 0,
  fritak_grunn   TEXT,                      -- barn under 16, yrkesskade, svangerskap, smittsom sykdom ...
  status         TEXT NOT NULL,             -- kladd | klar | sendt | godkjent | avvist | delvis
  oppgjor_id     TEXT,
  avvisning      TEXT,
  opprettet      TEXT NOT NULL,
  oppdatert      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regningskort_status ON regningskort (status, dato);

CREATE TABLE IF NOT EXISTS regningslinje (
  id             TEXT PRIMARY KEY,
  regningskort_id TEXT NOT NULL REFERENCES regningskort(id) ON DELETE CASCADE,
  takstkode      TEXT NOT NULL,
  antall         INTEGER NOT NULL DEFAULT 1,
  refusjon_ore   INTEGER NOT NULL DEFAULT 0,
  egenandel_ore  INTEGER NOT NULL DEFAULT 0,
  merknad        TEXT
);
CREATE INDEX IF NOT EXISTS idx_regningslinje_kort ON regningslinje (regningskort_id);

-- Innsending (oppgjørsfil) til Helfo.
CREATE TABLE IF NOT EXISTS oppgjor (
  id            TEXT PRIMARY KEY,
  periode_fra   TEXT NOT NULL,
  periode_til   TEXT NOT NULL,
  antall_kort   INTEGER NOT NULL,
  sum_refusjon_ore INTEGER NOT NULL,
  sum_egenandel_ore INTEGER NOT NULL,
  status        TEXT NOT NULL,              -- generert | sendt | mottatt | avregnet | avvist
  kvittering    TEXT,
  fil           TEXT,
  opprettet     TEXT NOT NULL,
  sendt         TEXT,
  sendt_av      TEXT
);

-- Sporing av frikort-/egenandeloppslag (skal loggføres som personopplysningsbehandling).
CREATE TABLE IF NOT EXISTS egenandel_oppslag (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  utfort      TEXT NOT NULL,
  utfort_av   TEXT NOT NULL,
  har_frikort INTEGER NOT NULL,
  frikort_til TEXT,
  opptjent_ore INTEGER,
  kilde       TEXT NOT NULL               -- helfo | manuell | cache
);

CREATE TABLE IF NOT EXISTS schema_version (
  versjon    INTEGER PRIMARY KEY,
  anvendt    TEXT NOT NULL
);
