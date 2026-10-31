-- What a user has already agreed to give an app.
--
-- Consent was asked on every launch, and an app in the record's side panel
-- opens on every patient. A dialog that appears that often is not a decision
-- anyone makes - it is a thing people click past without reading, which is
-- worse than not asking at all.
--
-- So it is asked once and remembered, per user and per app, together with the
-- scopes that were agreed. Asking again is then only necessary when the app
-- wants something the user has not already granted, which is exactly when a
-- person ought to look.
--
-- A practice may also grant on everyone's behalf - `oauth_client.require_consent`
-- set to false - for an app it has placed in the record itself.
CREATE TABLE IF NOT EXISTS oauth_consent (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  -- The scopes agreed to, space separated, as they were narrowed at the time.
  scopes     TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_consent_user_client_idx
  ON oauth_consent (tenant_id, user_id, client_id)
  WHERE revoked_at IS NULL;
