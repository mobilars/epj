-- The developer portal, and the catalogue of apps a practice can install.
--
-- Three parties, and the tables follow them:
--
--   a developer   registers, describes an app, and submits it
--   the platform  reviews it, and approves or refuses with a reason
--   a practice    installs an approved app into its own organisation
--
-- Nothing here is per organisation, unlike the rest of the schema: a developer
-- is not a member of a practice, and an app in the catalogue exists before any
-- practice has heard of it. Installing is what makes it real somewhere, and
-- that creates an ordinary oauth_client in the practice's own register, with
-- its own client id. Two practices installing the same app get two clients,
-- and revoking one leaves the other alone.

CREATE TABLE IF NOT EXISTS developer (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL DEFAULT '',
  organisation TEXT NOT NULL DEFAULT '',
  -- 'aktiv' or 'sperret'. A developer is not deleted: their apps and the
  -- decisions taken about them have to stay readable.
  status       TEXT NOT NULL DEFAULT 'aktiv',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login   TIMESTAMPTZ
);

-- Sign-in is by a code sent to the address, and nothing else.
--
-- There is no password to leak, reuse or reset. What proves who someone is, is
-- that they read mail at the address their apps are registered to - which is
-- the address that matters anyway when something has to be revoked in a hurry.
CREATE TABLE IF NOT EXISTS developer_login_code (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS developer_login_code_email_idx ON developer_login_code (email, created_at DESC);

CREATE TABLE IF NOT EXISTS developer_session (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developer(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS developer_session_developer_idx ON developer_session (developer_id);

-- An app as the developer describes it, before any practice has it.
--
-- `status` moves utkast -> til-vurdering -> godkjent | avvist. A developer may
-- edit a draft freely; editing an approved app puts it back for review, since
-- what was approved was a particular set of scopes and addresses.
CREATE TABLE IF NOT EXISTS catalogue_app (
  id                  TEXT PRIMARY KEY,
  developer_id        TEXT NOT NULL REFERENCES developer(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  launch_url          TEXT NOT NULL,
  redirect_uris       JSONB NOT NULL DEFAULT '[]'::jsonb,
  scopes              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Where the app expects to be shown: ingen, hoved or side.
  placement           TEXT NOT NULL DEFAULT 'ingen',
  contact_email       TEXT NOT NULL DEFAULT '',
  privacy_url         TEXT NOT NULL DEFAULT '',
  databehandleravtale TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'utkast',
  review_note         TEXT,
  reviewed_at         TIMESTAMPTZ,
  reviewed_by         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalogue_app_developer_idx ON catalogue_app (developer_id);
CREATE INDEX IF NOT EXISTS catalogue_app_status_idx ON catalogue_app (status);

-- Which practice installed which catalogue app, and as which client.
--
-- The link is what lets a practice see that an update is waiting, and what
-- lets the platform see where an app is in use when something is wrong with
-- it. Removing the client does not remove the history.
CREATE TABLE IF NOT EXISTS catalogue_install (
  id           TEXT PRIMARY KEY,
  catalogue_id TEXT NOT NULL REFERENCES catalogue_app(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS catalogue_install_tenant_idx ON catalogue_install (tenant_id, catalogue_id);
