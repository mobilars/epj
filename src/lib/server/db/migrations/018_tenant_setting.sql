-- Settings that belong to the practice rather than to a person.
--
-- The counterpart of user_setting. Which cards the work surface and the
-- patient overview show, and in what order, is the first of them: a practice
-- decides the default for everyone, and a person may still arrange their own
-- (user_setting wins where it exists). Free-form key/value like user_setting,
-- and for the same reason - a setting that needs a migration is a feature.

CREATE TABLE IF NOT EXISTS tenant_setting (
  tenant_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (tenant_id, key)
);

COMMENT ON TABLE tenant_setting IS
  'Per-practice settings. A user_setting with the same key overrides it for that person.';
