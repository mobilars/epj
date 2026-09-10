-- Signing in with an emailed code, and self-service trials.
--
-- The record's own sign-in stays as it was: HelseID for real use, username and
-- password with two-factor where that is turned on. This adds a third way in
-- for people who have no HelseID and are not staff at a Norwegian practice -
-- somebody trying the system out. It is the same mechanism the developer
-- portal uses: a code to the address, and nothing else.
--
-- It is not offered instead of HelseID. A trial organisation holds synthetic
-- data by definition, and an installation that sees real patients should have
-- this turned off - EPJ_EPOST_INNLOGGING.

CREATE TABLE IF NOT EXISTS user_login_code (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  -- Which organisation the code was asked for. Null on the shared trial
  -- hostname, where the organisation follows from whose address it is.
  tenant_id  TEXT,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS user_login_code_email_idx ON user_login_code (email, created_at DESC);

-- An organisation someone created to try the system.
--
-- Recorded separately from `tenant` so the platform can tell at a glance which
-- organisations are trials, who asked for one, and when they stop being
-- interesting. A trial is not a customer, and the difference should not have
-- to be guessed from the name.
CREATE TABLE IF NOT EXISTS trial (
  tenant_id     TEXT PRIMARY KEY,
  contact_name  TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL,
  practice_name TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS trial_email_idx ON trial (contact_email);

-- Email is how a person is recognised when signing in this way, so two
-- accounts in one organisation must not share one.
CREATE UNIQUE INDEX IF NOT EXISTS user_account_tenant_email_idx
  ON user_account (tenant_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';
