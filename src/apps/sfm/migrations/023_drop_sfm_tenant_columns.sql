-- The values moved to tenant_setting in 022, and no running version reads these.

ALTER TABLE tenant DROP COLUMN IF EXISTS sfm_journal_id;
ALTER TABLE tenant DROP COLUMN IF EXISTS sfm_parent_organisation_number;
