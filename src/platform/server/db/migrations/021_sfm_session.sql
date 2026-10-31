-- What the record needs to open Sentral forskrivningsmodul (SFM) for a user.
--
-- SFM acts on behalf of the signed-in clinician: it requires that person's own
-- HelseID token, and exchanges it for tokens towards Reseptformidleren and
-- Kjernejournal. The record has until now thrown the token away after sign-in,
-- because nothing needed it.
--
-- It is kept here, encrypted, for as long as the session lives and no longer.
-- It never reaches the browser. The DPoP key it is bound to is stored with it,
-- since the token cannot be used without it.
CREATE TABLE IF NOT EXISTS helseid_session_token (
  session_id  TEXT PRIMARY KEY REFERENCES user_session(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenant(id),
  encrypted   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which journal in SFM a practice is, for a multi-tenant HelseID client. The
-- record creates and keeps this id per customer; several may point at one SFM
-- instance. Null for a practice not on SFM, or on a single-tenant client.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS sfm_journal_id TEXT;

-- The top-level unit in Enhetsregisteret. The practice's own number is the
-- child; a practice that is its own top level leaves this empty.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS sfm_parent_organisation_number TEXT;
