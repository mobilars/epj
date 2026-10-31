-- What a developer agreed to, and when.
--
-- One row per acceptance, never updated. The question that gets asked later is
-- not "which terms apply now" but "what did this person agree to, and when" -
-- and that is only answerable if the old rows are still there. A change to the
-- terms means a new version, a new row, and a developer who is asked again
-- before they can carry on.
CREATE TABLE IF NOT EXISTS developer_terms (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developer(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS developer_terms_developer_idx ON developer_terms (developer_id, accepted_at DESC);
