-- Diabetesoversikt also shows the diagnosis and the medicines, so its example data has
-- to include them. Users are asked to approve the wider access.
UPDATE catalogue_app
SET scopes = '["openid","fhirUser","launch","launch/patient","online_access","patient/Patient.rs","patient/Observation.rs","patient/Observation.cu","patient/Condition.rs","patient/Condition.cu","patient/MedicationRequest.rs","patient/MedicationRequest.cu"]'
WHERE is_platform_app AND name = 'Diabetesoversikt (demo)';

UPDATE oauth_client c
SET allowed_scopes = a.scopes
FROM catalogue_install i
JOIN catalogue_app a ON a.id = i.catalogue_id
WHERE a.is_platform_app AND a.name = 'Diabetesoversikt (demo)'
  AND c.tenant_id = i.tenant_id AND c.client_id = i.client_id;
