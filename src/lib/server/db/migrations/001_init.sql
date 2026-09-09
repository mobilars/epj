-- ---------------------------------------------------------------------------
-- EPJ - applikasjonsdatabase (PostgreSQL)
--
-- Kliniske data lagres IKKE her. De ligger i HAPI FHIR sitt eget skjema, som
-- eier FHIR-ressurser, versjonshistorikk og søkeindekser. Denne databasen
-- inneholder identitets- og tilgangsdata, sikkerhetslogg, og tilstand for
-- integrasjonene mot SFM, NHN meldingstjener og Helfo.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS epj;
SET search_path TO epj, public;

CREATE TABLE IF NOT EXISTS schema_migration (
  versjon   INTEGER PRIMARY KEY,
  navn      TEXT NOT NULL,
  anvendt   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sikkerhetslogg (EPJ-standard kapittel om logging).
-- Hash-lenket: hver rad binder seg til forrige rads hash, slik at sletting
-- eller endring av historiske rader oppdages ved verifisering.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_event (
  seq            BIGSERIAL PRIMARY KEY,
  recorded       TIMESTAMPTZ NOT NULL DEFAULT now(),
  type_code      TEXT NOT NULL,
  subtype        TEXT,
  action         TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  outcome_desc   TEXT,
  actor_user_id  TEXT,
  actor_ref      TEXT,
  actor_navn     TEXT,
  actor_rolle    TEXT,
  client_id      TEXT,
  source_ip      TEXT,
  patient_id     TEXT,
  entity_ref     TEXT,
  purpose_of_use TEXT,
  request_id     TEXT,
  content        JSONB NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_event (patient_id, recorded DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_event (actor_user_id, recorded DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time    ON audit_event (recorded DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_event (request_id);

-- Loggen er append-only. Oppdatering og sletting blokkeres i databasen selv,
-- slik at en feil i applikasjonslaget ikke kan endre historikken.
CREATE OR REPLACE FUNCTION epj.audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sikkerhetsloggen er append-only (forsøk på %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_event;
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION epj.audit_append_only();

-- ---------------------------------------------------------------------------
-- Brukere, roller og tilgangsstyring
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_account (
  id                TEXT PRIMARY KEY,
  brukernavn        TEXT NOT NULL UNIQUE,
  navn              TEXT NOT NULL,
  epost             TEXT,
  hpr_nummer        TEXT,
  practitioner_id   TEXT,
  passord_hash      TEXT,
  totp_secret_enc   TEXT,
  mfa_aktivert      BOOLEAN NOT NULL DEFAULT false,
  helseid_sub       TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'aktiv',
  ma_bytte_passord  BOOLEAN NOT NULL DEFAULT false,
  feilede_forsok    INTEGER NOT NULL DEFAULT 0,
  laast_til         TIMESTAMPTZ,
  siste_innlogging  TIMESTAMPTZ,
  opprettet         TIMESTAMPTZ NOT NULL DEFAULT now(),
  oppdatert         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_practitioner ON user_account (practitioner_id);

CREATE TABLE IF NOT EXISTS role_assignment (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  rolle        TEXT NOT NULL,
  gyldig_fra   TIMESTAMPTZ NOT NULL DEFAULT now(),
  gyldig_til   TIMESTAMPTZ,
  tildelt_av   TEXT,
  begrunnelse  TEXT
);
CREATE INDEX IF NOT EXISTS idx_role_user ON role_assignment (user_id);

-- Tjenstlig behov: dokumentert behandlingsrelasjon mellom bruker og pasient.
CREATE TABLE IF NOT EXISTS care_relationship (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  patient_id    TEXT NOT NULL,
  grunnlag      TEXT NOT NULL,
  gyldig_fra    TIMESTAMPTZ NOT NULL DEFAULT now(),
  gyldig_til    TIMESTAMPTZ,
  opprettet_av  TEXT
);
CREATE INDEX IF NOT EXISTS idx_care_user_patient ON care_relationship (user_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_care_patient ON care_relationship (patient_id);

-- Nødrettstilgang. Alltid tidsbegrenset, alltid begrunnet, alltid logget.
CREATE TABLE IF NOT EXISTS break_glass (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  patient_id      TEXT NOT NULL,
  begrunnelse     TEXT NOT NULL,
  startet         TIMESTAMPTZ NOT NULL DEFAULT now(),
  utloper         TIMESTAMPTZ NOT NULL,
  varslet         BOOLEAN NOT NULL DEFAULT false,
  gjennomgatt_av  TEXT,
  gjennomgatt_tid TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bg_aktiv ON break_glass (user_id, patient_id, utloper DESC);

-- Sperring av journal. Speiles som FHIR Consent, men håndheves herfra.
CREATE TABLE IF NOT EXISTS journal_sperring (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  omfang         TEXT NOT NULL,
  mal_user_id    TEXT,
  mal_rolle      TEXT,
  mal_ressurs    TEXT,
  begrunnelse    TEXT,
  consent_id     TEXT,
  registrert     TIMESTAMPTZ NOT NULL DEFAULT now(),
  registrert_av  TEXT NOT NULL,
  gyldig_til     TIMESTAMPTZ,
  opphevet       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_sperring_patient ON journal_sperring (patient_id) WHERE opphevet = false;

-- ---------------------------------------------------------------------------
-- OAuth 2.1 / SMART on FHIR
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_client (
  client_id           TEXT PRIMARY KEY,
  navn                TEXT NOT NULL,
  type                TEXT NOT NULL,
  klient_kategori     TEXT NOT NULL,
  secret_hash         TEXT,
  jwks                JSONB,
  jwks_uri            TEXT,
  redirect_uris       JSONB NOT NULL DEFAULT '[]'::jsonb,
  tillatte_scopes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  grant_types         JSONB NOT NULL DEFAULT '["authorization_code"]'::jsonb,
  krev_pkce           BOOLEAN NOT NULL DEFAULT true,
  krev_samtykke       BOOLEAN NOT NULL DEFAULT true,
  logo_url            TEXT,
  databehandleravtale TEXT,
  status              TEXT NOT NULL DEFAULT 'aktiv',
  opprettet           TIMESTAMPTZ NOT NULL DEFAULT now(),
  opprettet_av        TEXT
);

CREATE TABLE IF NOT EXISTS oauth_authorization_code (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  nonce                 TEXT,
  launch_context        JSONB NOT NULL DEFAULT '{}'::jsonb,
  utloper               TIMESTAMPTZ NOT NULL,
  brukt                 BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_authcode_utloper ON oauth_authorization_code (utloper);

CREATE TABLE IF NOT EXISTS oauth_token (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  client_id         TEXT NOT NULL,
  user_id           TEXT,
  scope             TEXT NOT NULL,
  launch_context    JSONB NOT NULL DEFAULT '{}'::jsonb,
  familie           TEXT NOT NULL,
  utstedt           TIMESTAMPTZ NOT NULL DEFAULT now(),
  utloper           TIMESTAMPTZ NOT NULL,
  tilbakekalt       BOOLEAN NOT NULL DEFAULT false,
  tilbakekalt_grunn TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_family ON oauth_token (familie);
CREATE INDEX IF NOT EXISTS idx_token_user   ON oauth_token (user_id, kind);

CREATE TABLE IF NOT EXISTS smart_launch (
  launch_id     TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  patient_id    TEXT,
  encounter_id  TEXT,
  intent        TEXT,
  opprettet     TIMESTAMPTZ NOT NULL DEFAULT now(),
  utloper       TIMESTAMPTZ NOT NULL,
  brukt         BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS signing_key (
  kid           TEXT PRIMARY KEY,
  alg           TEXT NOT NULL,
  public_jwk    JSONB NOT NULL,
  private_enc   TEXT NOT NULL,
  opprettet     TIMESTAMPTZ NOT NULL DEFAULT now(),
  aktiv         BOOLEAN NOT NULL DEFAULT true,
  utfases_etter TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_session (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  opprettet    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sist_aktiv   TIMESTAMPTZ NOT NULL DEFAULT now(),
  utloper      TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  amr          TEXT,
  elevert_til  TIMESTAMPTZ,
  avsluttet    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_session_user ON user_session (user_id) WHERE avsluttet = false;

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket      TEXT PRIMARY KEY,
  teller      INTEGER NOT NULL,
  vindu_start BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Integrasjoner
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS melding (
  id            TEXT PRIMARY KEY,
  retning       TEXT NOT NULL,
  meldingstype  TEXT NOT NULL,
  msg_id        TEXT NOT NULL,
  ref_msg_id    TEXT,
  patient_id    TEXT,
  avsender_her  TEXT,
  mottaker_her  TEXT,
  mottaker_navn TEXT,
  status        TEXT NOT NULL,
  status_detalj TEXT,
  apprec_status TEXT,
  forsok        INTEGER NOT NULL DEFAULT 0,
  neste_forsok  TIMESTAMPTZ,
  payload_xml   TEXT,
  ebxml         TEXT,
  fhir_ref      TEXT,
  opprettet     TIMESTAMPTZ NOT NULL DEFAULT now(),
  oppdatert     TIMESTAMPTZ NOT NULL DEFAULT now(),
  opprettet_av  TEXT,
  signatur      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_melding_msgid ON melding (retning, msg_id);
CREATE INDEX IF NOT EXISTS idx_melding_ko ON melding (status, neste_forsok);
CREATE INDEX IF NOT EXISTS idx_melding_pasient ON melding (patient_id, opprettet DESC);

CREATE TABLE IF NOT EXISTS sfm_synk (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL,
  operasjon    TEXT NOT NULL,
  status       TEXT NOT NULL,
  foresporsel  JSONB,
  svar         JSONB,
  feilmelding  TEXT,
  reseptid     TEXT,
  opprettet    TIMESTAMPTZ NOT NULL DEFAULT now(),
  oppdatert    TIMESTAMPTZ NOT NULL DEFAULT now(),
  utfort_av    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sfm_pasient ON sfm_synk (patient_id, opprettet DESC);

CREATE TABLE IF NOT EXISTS regningskort (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL,
  encounter_id    TEXT,
  behandler_id    TEXT NOT NULL,
  hpr_nummer      TEXT,
  dato            DATE NOT NULL,
  kontakttype     TEXT NOT NULL,
  diagnose_kode   TEXT,
  diagnose_system TEXT,
  refusjon_ore    BIGINT NOT NULL DEFAULT 0,
  egenandel_ore   BIGINT NOT NULL DEFAULT 0,
  frikort         BOOLEAN NOT NULL DEFAULT false,
  fritak_grunn    TEXT,
  status          TEXT NOT NULL DEFAULT 'kladd',
  oppgjor_id      TEXT,
  avvisning       TEXT,
  claim_id        TEXT,
  opprettet       TIMESTAMPTZ NOT NULL DEFAULT now(),
  oppdatert       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regningskort_status ON regningskort (status, dato);
CREATE INDEX IF NOT EXISTS idx_regningskort_pasient ON regningskort (patient_id, dato DESC);

CREATE TABLE IF NOT EXISTS regningslinje (
  id              TEXT PRIMARY KEY,
  regningskort_id TEXT NOT NULL REFERENCES regningskort(id) ON DELETE CASCADE,
  takstkode       TEXT NOT NULL,
  antall          INTEGER NOT NULL DEFAULT 1,
  refusjon_ore    BIGINT NOT NULL DEFAULT 0,
  egenandel_ore   BIGINT NOT NULL DEFAULT 0,
  merknad         TEXT
);
CREATE INDEX IF NOT EXISTS idx_regningslinje_kort ON regningslinje (regningskort_id);

CREATE TABLE IF NOT EXISTS oppgjor (
  id                TEXT PRIMARY KEY,
  periode_fra       DATE NOT NULL,
  periode_til       DATE NOT NULL,
  antall_kort       INTEGER NOT NULL,
  sum_refusjon_ore  BIGINT NOT NULL,
  sum_egenandel_ore BIGINT NOT NULL,
  status            TEXT NOT NULL,
  kvittering        JSONB,
  fil               TEXT,
  opprettet         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sendt             TIMESTAMPTZ,
  sendt_av          TEXT
);

CREATE TABLE IF NOT EXISTS egenandel_oppslag (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL,
  utfort       TIMESTAMPTZ NOT NULL DEFAULT now(),
  utfort_av    TEXT NOT NULL,
  har_frikort  BOOLEAN NOT NULL,
  frikort_til  DATE,
  opptjent_ore BIGINT,
  kilde        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_egenandel_pasient ON egenandel_oppslag (patient_id, utfort DESC);
