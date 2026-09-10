-- Lets an app be placed in the main menu.
--
-- Starting an app took four steps: find the patient, open the record, open the
-- Apper tab, press start. For an app used in most consultations that is three
-- steps too many. An app marked here sits in the main menu instead, and starts
-- with the patient already in context when one is open.
--
-- Off by default: the main menu is small on purpose, and an app earns a place
-- in it by being used constantly.

ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS in_main_menu BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN oauth_client.in_main_menu IS
  'Whether the app appears directly in the main menu rather than under the apps dropdown.';
