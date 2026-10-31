-- Apps now reach a practice through the catalogue, and count as approved when the
-- platform owner has approved them there. The exception is the apps built in this
-- repository, which the platform registers itself by script.
--
-- Anything else already registered directly keeps working, but counts as not
-- approved, and says so wherever it is shown.
ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS first_party BOOLEAN NOT NULL DEFAULT false;

UPDATE oauth_client
SET first_party = true
WHERE publisher = 'APUS Roland AS'
  AND (tenant_id, client_id) NOT IN (SELECT tenant_id, client_id FROM catalogue_install);
