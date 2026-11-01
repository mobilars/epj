-- The client id belongs to the app, like its secret, so that an app serving many
-- customers has one registration. Each practice still has a row of its own, with its
-- own consents, status and tokens, so the key becomes the pair.
ALTER TABLE oauth_client DROP CONSTRAINT IF EXISTS oauth_client_pkey;
ALTER TABLE oauth_client ADD PRIMARY KEY (tenant_id, client_id);

ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS client_id TEXT NOT NULL DEFAULT ('epj-' || gen_random_uuid()::text);

-- An app already installed keeps the id its vendor has configured. A practice that
-- installed it later keeps its own id too, until it installs the app again.
UPDATE catalogue_app a
SET client_id = first_install.client_id
FROM (
	SELECT DISTINCT ON (catalogue_id) catalogue_id, client_id
	FROM catalogue_install
	ORDER BY catalogue_id, installed_at
) first_install
WHERE first_install.catalogue_id = a.id;

CREATE UNIQUE INDEX IF NOT EXISTS catalogue_app_client_id_idx ON catalogue_app (client_id);
