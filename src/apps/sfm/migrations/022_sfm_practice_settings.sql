-- SFM's per-practice settings move to tenant_setting, so the platform's practice
-- table no longer has to know about SFM. The columns stay until the next
-- migration: a pod still running the previous version selects them.

INSERT INTO tenant_setting (tenant_id, key, value)
SELECT id, 'app:sfm:journal_id', sfm_journal_id FROM tenant
WHERE sfm_journal_id IS NOT NULL AND sfm_journal_id <> ''
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO tenant_setting (tenant_id, key, value)
SELECT id, 'app:sfm:parent_organisation_number', sfm_parent_organisation_number FROM tenant
WHERE sfm_parent_organisation_number IS NOT NULL AND sfm_parent_organisation_number <> ''
ON CONFLICT (tenant_id, key) DO NOTHING;
