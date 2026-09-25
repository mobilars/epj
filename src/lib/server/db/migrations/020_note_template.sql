-- A clinician's own templates for record notes.
--
-- Much of a consultation note is the same every time for the same kind of
-- visit: the headings of an annual diabetes check, the questions of a driving
-- licence assessment, the plan after an uncomplicated respiratory infection.
-- A template fills the form with that, and the clinician writes what is
-- particular to this patient.
--
-- Personal, not shared: each clinician writes and structures notes their own
-- way, and a template someone else can change under you is a note you did not
-- write. A template is not patient data - it is text the clinician wrote before
-- any patient was chosen - so it lives here rather than in the record.

CREATE TABLE IF NOT EXISTS note_template (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenant(id),
  user_id     TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  title       TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  subjective  TEXT NOT NULL DEFAULT '' CHECK (length(subjective) <= 10000),
  objective   TEXT NOT NULL DEFAULT '' CHECK (length(objective) <= 10000),
  assessment  TEXT NOT NULL DEFAULT '' CHECK (length(assessment) <= 10000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_note_template_owner ON note_template (tenant_id, user_id);
