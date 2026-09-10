-- Where an app is shown, what a user prefers, and the CDS services to ask.
--
-- The record is being taken apart into pieces that can be replaced. A note
-- editor, a medication list and a critical-information panel are all just
-- views of FHIR resources, and there is no reason the record's own version has
-- to be the one a practice uses. Making them apps means a practice can swap
-- one out without us shipping a new version - and it forces the record's own
-- surfaces through the same door third parties come in by, which is the only
-- way to know that door works.

-- 'ingen'  the app is started deliberately and takes over the view
-- 'hoved'  the wide surface, beside the record's own content
-- 'side'   the narrow panel down the right-hand side
ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'ingen';

COMMENT ON COLUMN oauth_client.placement IS
  'Where the app is rendered in the record: ingen (on demand), hoved (wide), side (narrow panel).';

-- What a user has chosen for themselves. Small, free-form and per organisation:
-- which app sits in the side panel, and whatever else turns out to be worth
-- remembering per person rather than per practice.
CREATE TABLE IF NOT EXISTS user_setting (
  user_id    TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS user_setting_tenant_idx ON user_setting (tenant_id);

-- CDS Hooks services the record asks for advice.
--
-- A service is asked at a defined moment - opening a record, prescribing - and
-- answers with cards: a warning, a suggestion, a link to an app. The record
-- decides what to do with them; a card is advice, never an instruction, and
-- nothing here may write to the record on its own.
CREATE TABLE IF NOT EXISTS cds_service (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  discovery_url TEXT NOT NULL,
  service_id   TEXT NOT NULL,
  hook         TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS cds_service_tenant_service_idx
  ON cds_service (tenant_id, discovery_url, service_id);
