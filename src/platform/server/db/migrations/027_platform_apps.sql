-- One way for an app to reach a practice: the catalogue.
--
-- The apps built in this repository were registered by script directly into a
-- practice, which left them outside both the developer portal and platform
-- administration. They become catalogue entries owned by the platform, and what the
-- practices already run becomes an ordinary installation of them.

ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS is_platform_app BOOLEAN NOT NULL DEFAULT false;
-- A record tab the app takes over when installed. Platform apps only.
ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS replaces_tab TEXT;

-- How an app proves who it is at the token endpoint: public (PKCE only), secret, keys.
-- The secret belongs to the catalogue entry, and installing copies its hash.
ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'public';
ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS secret_hash TEXT;
ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS jwks JSONB;
ALTER TABLE catalogue_app ADD COLUMN IF NOT EXISTS jwks_uri TEXT;

-- Owns the platform apps. Not a person: blocked, and on a domain that cannot receive
-- the sign-in code, so nobody can sign in as it.
INSERT INTO developer (id, email, name, organisation, status)
VALUES ('plattform-apus', 'plattform@epj.invalid', 'APUS Roland AS', 'APUS Roland AS', 'sperret')
ON CONFLICT (id) DO NOTHING;

-- One entry per app, however many practices run it.
INSERT INTO catalogue_app (id, developer_id, name, summary, launch_url, redirect_uris, scopes, placement,
	databehandleravtale, status, reviewed_at, is_platform_app, replaces_tab)
SELECT DISTINCT ON (c.name)
	'plattform-' || md5(c.name), 'plattform-apus', c.name, COALESCE(c.databehandleravtale, ''),
	REPLACE(COALESCE(c.launch_url, ''), c.client_id, '{client_id}'), to_jsonb(c.redirect_uris), to_jsonb(c.allowed_scopes),
	c.placement, COALESCE(c.databehandleravtale, ''), 'godkjent', now(), true, c.replaces_tab
FROM oauth_client c
WHERE c.first_party
ORDER BY c.name, c.created_at
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalogue_install (id, catalogue_id, tenant_id, client_id, approved_copy)
SELECT md5(c.tenant_id || c.client_id), 'plattform-' || md5(c.name), c.tenant_id, c.client_id, true
FROM oauth_client c
WHERE c.first_party
ON CONFLICT DO NOTHING;

-- An approved edit used to reach a practice without its name, so an app renamed in
-- the portal kept the old name there. Bring every approved copy up to date.
UPDATE oauth_client c
SET name = a.name, redirect_uris = to_jsonb(a.redirect_uris), allowed_scopes = to_jsonb(a.scopes),
	launch_url = REPLACE(a.launch_url, '{client_id}', c.client_id)
FROM catalogue_install i
JOIN catalogue_app a ON a.id = i.catalogue_id
WHERE i.approved_copy AND a.status = 'godkjent'
  AND c.tenant_id = i.tenant_id AND c.client_id = i.client_id;
