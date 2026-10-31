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
  version   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
  actor_name     TEXT,
  actor_role    TEXT,
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
  username        TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  email             TEXT,
  hpr_number        TEXT,
  practitioner_id   TEXT,
  password_hash      TEXT,
  totp_secret_enc   TEXT,
  mfa_aktivert      BOOLEAN NOT NULL DEFAULT false,
  helseid_sub       TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'aktiv',
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_practitioner ON user_account (practitioner_id);

CREATE TABLE IF NOT EXISTS role_assignment (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until   TIMESTAMPTZ,
  assigned_by   TEXT,
  justification  TEXT
);
CREATE INDEX IF NOT EXISTS idx_role_user ON role_assignment (user_id);

-- Tjenstlig behov: dokumentert behandlingsrelasjon mellom bruker og pasient.
CREATE TABLE IF NOT EXISTS care_relationship (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  patient_id    TEXT NOT NULL,
  basis      TEXT NOT NULL,
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until    TIMESTAMPTZ,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_care_user_patient ON care_relationship (user_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_care_patient ON care_relationship (patient_id);

-- Nødrettstilgang. Alltid tidsbegrenset, alltid begrunnet, alltid logget.
CREATE TABLE IF NOT EXISTS break_glass (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  patient_id      TEXT NOT NULL,
  justification     TEXT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  notified         BOOLEAN NOT NULL DEFAULT false,
  reviewed_by  TEXT,
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bg_active ON break_glass (user_id, patient_id, expires_at DESC);

-- Sperring av journal. Speiles som FHIR Consent, men håndheves herfra.
CREATE TABLE IF NOT EXISTS record_restriction (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  scope_extent         TEXT NOT NULL,
  target_user_id    TEXT,
  target_role      TEXT,
  target_resource    TEXT,
  justification    TEXT,
  consent_id     TEXT,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_by  TEXT NOT NULL,
  valid_until     TIMESTAMPTZ,
  lifted       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_restriction_patient ON record_restriction (patient_id) WHERE lifted = false;

-- ---------------------------------------------------------------------------
-- OAuth 2.1 / SMART on FHIR
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_client (
  client_id           TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  client_category     TEXT NOT NULL,
  secret_hash         TEXT,
  jwks                JSONB,
  jwks_uri            TEXT,
  redirect_uris       JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_scopes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  grant_types         JSONB NOT NULL DEFAULT '["authorization_code"]'::jsonb,
  require_pkce           BOOLEAN NOT NULL DEFAULT true,
  require_consent       BOOLEAN NOT NULL DEFAULT true,
  logo_url            TEXT,
  databehandleravtale TEXT,
  status              TEXT NOT NULL DEFAULT 'aktiv',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT
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
  expires_at               TIMESTAMPTZ NOT NULL,
  used                 BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_authcode_expires_at ON oauth_authorization_code (expires_at);

CREATE TABLE IF NOT EXISTS oauth_token (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  client_id         TEXT NOT NULL,
  user_id           TEXT,
  scope             TEXT NOT NULL,
  launch_context    JSONB NOT NULL DEFAULT '{}'::jsonb,
  familie           TEXT NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  revoked_reason TEXT
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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS signing_key (
  kid           TEXT PRIMARY KEY,
  alg           TEXT NOT NULL,
  public_jwk    JSONB NOT NULL,
  private_enc   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active         BOOLEAN NOT NULL DEFAULT true,
  phased_out_after TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_session (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  amr          TEXT,
  elevated_until  TIMESTAMPTZ,
  ended    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_session_user ON user_session (user_id) WHERE ended = false;

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket      TEXT PRIMARY KEY,
  counter      INTEGER NOT NULL,
  window_start BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Integrasjoner
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message (
  id            TEXT PRIMARY KEY,
  direction       TEXT NOT NULL,
  message_type  TEXT NOT NULL,
  msg_id        TEXT NOT NULL,
  ref_msg_id    TEXT,
  patient_id    TEXT,
  sender_her_id  TEXT,
  recipient_her_id  TEXT,
  recipient_name TEXT,
  status        TEXT NOT NULL,
  status_detail TEXT,
  apprec_status TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt  TIMESTAMPTZ,
  payload_xml   TEXT,
  ebxml         TEXT,
  fhir_ref      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  signatur      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_msgid ON message (direction, msg_id);
CREATE INDEX IF NOT EXISTS idx_message_queue ON message (status, next_attempt);
CREATE INDEX IF NOT EXISTS idx_message_patient ON message (patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sfm_sync (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL,
  operation    TEXT NOT NULL,
  status       TEXT NOT NULL,
  request  JSONB,
  response         JSONB,
  feilmelding  TEXT,
  reseptid     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  performed_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sfm_patient ON sfm_sync (patient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_card (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL,
  encounter_id    TEXT,
  practitioner_id    TEXT NOT NULL,
  hpr_number      TEXT,
  date            DATE NOT NULL,
  kontakttype     TEXT NOT NULL,
  diagnosis_code   TEXT,
  diagnosis_system TEXT,
  reimbursement_ore    BIGINT NOT NULL DEFAULT 0,
  copayment_ore   BIGINT NOT NULL DEFAULT 0,
  exemption_card         BOOLEAN NOT NULL DEFAULT false,
  exemption_reason    TEXT,
  status          TEXT NOT NULL DEFAULT 'kladd',
  settlement_id      TEXT,
  rejection       TEXT,
  claim_id        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_card_status ON billing_card (status, date);
CREATE INDEX IF NOT EXISTS idx_billing_card_patient ON billing_card (patient_id, date DESC);

CREATE TABLE IF NOT EXISTS billing_line (
  id              TEXT PRIMARY KEY,
  billing_card_id TEXT NOT NULL REFERENCES billing_card(id) ON DELETE CASCADE,
  tariff_code       TEXT NOT NULL,
  count          INTEGER NOT NULL DEFAULT 1,
  reimbursement_ore    BIGINT NOT NULL DEFAULT 0,
  copayment_ore   BIGINT NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_line_card ON billing_line (billing_card_id);

CREATE TABLE IF NOT EXISTS settlement (
  id                TEXT PRIMARY KEY,
  period_from       DATE NOT NULL,
  period_to       DATE NOT NULL,
  card_count       INTEGER NOT NULL,
  sum_reimbursement_ore  BIGINT NOT NULL,
  sum_copayment_ore BIGINT NOT NULL,
  status            TEXT NOT NULL,
  receipt        JSONB,
  file               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  sent_by          TEXT
);

CREATE TABLE IF NOT EXISTS copayment_lookup (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL,
  utfort       TIMESTAMPTZ NOT NULL DEFAULT now(),
  performed_by    TEXT NOT NULL,
  has_exemption_card  BOOLEAN NOT NULL,
  exemption_card_until  DATE,
  earned_ore BIGINT,
  source        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copayment_patient ON copayment_lookup (patient_id, utfort DESC);
