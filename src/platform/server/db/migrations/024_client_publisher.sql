-- Who made an app, for one registered directly rather than installed from the
-- catalogue, where the developer is already on record. Empty when nobody has said.
ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS publisher TEXT;

-- The apps built in this repository (deploy/apus/demo-app, and the seeded demo).
-- Matched on where they run: the seed and the registration script set it from now on.
UPDATE oauth_client
SET publisher = 'APUS Roland AS'
WHERE launch_url ~ '^https://(notat|kritisk|legemidler|smartdemo)\.apps\.apus\.no/'
   OR name = 'Diabetesoversikt (demo)';
