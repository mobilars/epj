-- Ties an attachment to the patient it belongs to.
--
-- Binary carries the bytes of a scanned document, a PDF or an image, and has no
-- subject of its own. That is why the type was taken out of the supported
-- resources in the security review: access control could not tell which patient
-- an attachment concerned, so neither legitimate need nor restriction could be
-- enforced, and a token with Binary scope could have fetched any attachment in
-- the practice.
--
-- The link is recorded here instead, at the moment the attachment is created,
-- from the patient in the app's launch context. Reading one is then judged
-- against that patient exactly as any other resource is - care relationship,
-- restriction, break-glass and audit alike. An attachment with no row here is
-- readable by nobody, so nothing can leak by being created out of band.
--
-- This is stricter than deriving the patient from the DocumentReference that
-- points at the attachment, which was the plan in docs/todo.md 4.8: an
-- orphaned Binary never becomes readable, and the upload itself can be
-- authorised, which that approach cannot do - the DocumentReference is written
-- after the Binary it refers to.

CREATE TABLE IF NOT EXISTS binary_patient (
  tenant_id  TEXT NOT NULL,
  binary_id  TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  PRIMARY KEY (tenant_id, binary_id)
);

CREATE INDEX IF NOT EXISTS idx_binary_patient_pasient
  ON binary_patient (tenant_id, patient_id);

COMMENT ON TABLE binary_patient IS
  'The patient an attachment belongs to. Binary has no subject, so access control has nowhere else to look.';
