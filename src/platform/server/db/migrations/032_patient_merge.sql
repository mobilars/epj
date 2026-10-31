-- Two records of one person, joined. What is kept here is what the record itself no
-- longer says: that these were two, who decided otherwise, and why. It is also how an
-- old address finds the record that replaced it, and how the access log of the kept
-- record still shows who looked at the other, as the patient has a right to know.
CREATE TABLE IF NOT EXISTS patient_merge (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  kept_patient_id   TEXT NOT NULL,
  merged_patient_id TEXT NOT NULL,
  merged_by         TEXT,
  reason            TEXT NOT NULL,
  moved_resources   INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS patient_merge_merged_idx ON patient_merge (tenant_id, merged_patient_id);
CREATE INDEX IF NOT EXISTS patient_merge_kept_idx ON patient_merge (tenant_id, kept_patient_id);
