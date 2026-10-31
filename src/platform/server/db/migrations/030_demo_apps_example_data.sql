-- The demo apps can add example data to a test patient, and take it out again, which
-- takes writing and updating measurements. Users are asked to approve the wider access.
UPDATE catalogue_app
SET scopes = '["openid","fhirUser","launch","launch/patient","online_access","patient/Patient.rs","patient/Observation.rs","patient/Observation.cu","patient/Condition.rs","patient/MedicationRequest.rs"]'
WHERE is_platform_app AND name = 'Diabetesoversikt (demo)';

UPDATE catalogue_app
SET scopes = '["openid","fhirUser","launch","launch/patient","online_access","patient/Patient.rs","patient/Observation.rs","patient/Observation.cu"]'
WHERE is_platform_app AND name = 'Vekstkurve';

UPDATE catalogue_app
SET scopes = '["openid","fhirUser","launch","launch/patient","online_access","patient/Patient.rs","patient/Observation.rs","patient/Observation.cu","patient/Condition.rs"]'
WHERE is_platform_app AND name = 'Hjerterisiko';

UPDATE oauth_client c
SET allowed_scopes = a.scopes
FROM catalogue_install i
JOIN catalogue_app a ON a.id = i.catalogue_id
WHERE a.is_platform_app AND a.name IN ('Diabetesoversikt (demo)', 'Vekstkurve', 'Hjerterisiko')
  AND c.tenant_id = i.tenant_id AND c.client_id = i.client_id;
