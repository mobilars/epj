-- Lets an app have a tab of its own in the patient record.
--
-- The Apper dropdown keeps the tab bar short, but an app used in most
-- consultations should not be a click further away than the notes. An app
-- marked here gets a tab beside Journalnotater and Legemidler, and starts with
-- the patient in context when pressed.
--
-- This is distinct from `in_main_menu` (cross-patient apps started without a
-- patient) and from `replaces_tab` (an app taking over one of the record's own
-- tabs). Off by default: the tab bar earns its width.

ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS in_patient_tabs BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN oauth_client.in_patient_tabs IS
  'Whether the app has its own tab in the patient record rather than sitting under the Apper dropdown.';
