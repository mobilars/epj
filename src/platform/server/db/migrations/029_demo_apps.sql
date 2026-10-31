-- The demo apps in deploy/apus/demo-app that have no entry yet. In the catalogue only:
-- a practice installs the ones it wants from the gallery.
INSERT INTO catalogue_app (id, developer_id, name, summary, launch_url, redirect_uris, scopes, placement, status, reviewed_at, is_platform_app)
VALUES
	('plattform-' || md5('Vekstkurve'), 'plattform-apus', 'Vekstkurve',
	 'Høyde og vekt over tid, med ny måling. Demonstrasjon, uten persentilkurver.',
	 'https://vekst.apps.apus.no/launch?client_id={client_id}', '["https://vekst.apps.apus.no/callback"]',
	 '["openid","fhirUser","launch","launch/patient","online_access","patient/Patient.rs","patient/Observation.rs","patient/Observation.c"]',
	 'ingen', 'godkjent', now(), true),
	('plattform-' || md5('Hjerterisiko'), 'plattform-apus', 'Hjerterisiko',
	 'Tiårsrisiko for hjerte- og karsykdom etter Framingham-modellen. Demonstrasjon, ikke NORRISK 2.',
	 'https://hjerterisiko.apps.apus.no/launch?client_id={client_id}', '["https://hjerterisiko.apps.apus.no/callback"]',
	 '["openid","fhirUser","launch","launch/patient","online_access","patient/Patient.rs","patient/Observation.rs","patient/Condition.rs"]',
	 'ingen', 'godkjent', now(), true)
ON CONFLICT (id) DO NOTHING;

-- Diabetesoversikt was registered with a local address and no app behind it. Where it
-- already exists it gets the real one. A fresh database gets it from the seed instead.
UPDATE catalogue_app
SET launch_url = 'https://diabetes.apps.apus.no/launch?client_id={client_id}',
    redirect_uris = '["https://diabetes.apps.apus.no/callback"]',
    summary = 'HbA1c, blodtrykk, vekt og legemidler på ett skjermbilde. Demonstrasjon.'
WHERE is_platform_app AND name = 'Diabetesoversikt (demo)';

UPDATE oauth_client c
SET redirect_uris = a.redirect_uris, launch_url = REPLACE(a.launch_url, '{client_id}', c.client_id)
FROM catalogue_install i
JOIN catalogue_app a ON a.id = i.catalogue_id
WHERE a.is_platform_app AND a.name = 'Diabetesoversikt (demo)'
  AND c.tenant_id = i.tenant_id AND c.client_id = i.client_id;
