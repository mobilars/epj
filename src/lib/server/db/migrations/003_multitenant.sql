-- ---------------------------------------------------------------------------
-- Multitenancy.
--
-- Én installasjon betjener flere virksomheter (legekontorer). Hver virksomhet
-- er en «tenant» med egen HAPI FHIR-partisjon, egne brukere, egen
-- sikkerhetslogg og egne signeringsnøkler.
--
-- Kliniske data skilles av HAPI sin partisjonering. Alt i dette skjemaet
-- skilles av `tenant_id`, som er obligatorisk på alle tables som kan
-- inneholde virksomhetsdata.
-- ---------------------------------------------------------------------------

SET search_path TO epj, public;

CREATE TABLE IF NOT EXISTS tenant (
  -- Kort maskinnavn. Brukes også som partisjonsnavn i HAPI FHIR, og inngår
  -- derfor i FHIR-URL-er: /fhir/<tenant>/Patient
  id                  TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  name                TEXT NOT NULL,
  organisation_number TEXT NOT NULL,
  her_id              TEXT,
  municipality_code       TEXT,
  -- Vertsnavnet virksomheten nås på. Tenant utledes fra dette ved hver
  -- forespørsel, slik at brukere aldri velger virksomhet selv.
  hostname           TEXT UNIQUE,
  -- Utadvendt adresse. Brukes som `issuer` i OAuth-metadata for virksomheten.
  base_url            TEXT NOT NULL,
  -- Partisjons-id i HAPI FHIR. Settes ved opprettelse og endres aldri.
  -- NULL for systemvirksomheter som ikke har kliniske data.
  partition_id        INTEGER UNIQUE CHECK (partition_id > 0),
  status              TEXT NOT NULL DEFAULT 'aktiv'
                        CHECK (status IN ('aktiv', 'suspendert', 'avviklet')),
  note             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_hostname ON tenant (hostname) WHERE status = 'aktiv';

-- Standardvirksomhet for installasjoner som allerede er i drift, og for
-- utvikling. Alle eksisterende rader knyttes til denne.
INSERT INTO tenant (id, name, organisation_number, her_id, base_url, partition_id, note)
VALUES ('standard', 'Standardvirksomhet', '999999999', '8000001',
        'http://localhost:5173', 1,
        'Opprettet automatisk ved innføring av multitenancy.')
ON CONFLICT (id) DO NOTHING;

-- Plattformen selv er også en «virksomhet», men uten klinisk innhold. Den
-- finnes for at plattformadministratorenes handlinger skal ha et sted å
-- loggføres, slik at sikkerhetsloggen kan være obligatorisk overalt.
INSERT INTO tenant (id, name, organisation_number, base_url, partition_id, status, note)
VALUES ('plattform', 'Plattformadministrasjon', '999999999',
        'http://localhost:5173', NULL, 'aktiv',
        'Systemvirksomhet. Har ingen FHIR-partisjon og ingen kliniske data.')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- `tenant_id` på alle tables som kan inneholde virksomhetsdata.
--
-- Kolonnen legges til uten NOT NULL, fylles for eksisterende rader, og settes
-- deretter til NOT NULL. Da virker migrasjonen både på tomme og fylte baser.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'audit_event', 'care_relationship', 'break_glass', 'record_restriction',
    'oauth_client', 'oauth_authorization_code', 'oauth_token', 'smart_launch',
    'signing_key', 'message', 'sfm_sync', 'billing_card', 'settlement',
    'copayment_lookup'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE epj.%I ADD COLUMN IF NOT EXISTS tenant_id TEXT', t);
    EXECUTE format('UPDATE epj.%I SET tenant_id = ''standard'' WHERE tenant_id IS NULL', t);
    EXECUTE format('ALTER TABLE epj.%I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format(
      'ALTER TABLE epj.%I DROP CONSTRAINT IF EXISTS %I, ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES epj.tenant(id)',
      t, t || '_tenant_fk', t || '_tenant_fk');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON epj.%I (tenant_id)', 'idx_' || t || '_tenant', t);
  END LOOP;
END $$;

-- Brukere: NULL betyr plattformadministrator, som ikke tilhører noen
-- virksomhet og aldri har klinisk tilgang.
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenant(id);
UPDATE user_account SET tenant_id = 'standard' WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_tenant ON user_account (tenant_id);

-- Brukernavn er unikt innenfor virksomheten, ikke på tvers. To legekontorer
-- kan begge ha en bruker som heter «lege».
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS user_account_username_key;
DROP INDEX IF EXISTS epj.idx_user_username_tenant;
CREATE UNIQUE INDEX idx_user_username_tenant
  ON user_account (tenant_id, lower(username)) NULLS NOT DISTINCT;

-- Samme person kan arbeide ved flere legekontorer, og har da én konto i hver.
-- HelseID-identiteten er derfor unik innenfor virksomheten, ikke globalt.
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS user_account_helseid_sub_key;
DROP INDEX IF EXISTS epj.idx_user_helseid_tenant;
CREATE UNIQUE INDEX idx_user_helseid_tenant
  ON user_account (tenant_id, helseid_sub) NULLS NOT DISTINCT
  WHERE helseid_sub IS NOT NULL;

-- Sikkerhetsloggen er hash-lenket per virksomhet, ikke på tvers: en virksomhet
-- skal kunne verifisere sin egen kjede uten å se de andres.
CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_event (tenant_id, seq DESC);

-- Meldings-id er unik per virksomhet og direction.
DROP INDEX IF EXISTS epj.idx_message_msgid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_msgid ON message (tenant_id, direction, msg_id);

-- Signeringsnøkler er per virksomhet, siden hver virksomhet har sin egen
-- `issuer` i OAuth-metadata.
CREATE INDEX IF NOT EXISTS idx_signing_key_tenant ON signing_key (tenant_id, active, created_at DESC);

-- Regningslinjer arver virksomhet gjennom regningskortet.
-- Ratebegrensning nøkles på tekst, og har virksomheten i selve nøkkelen.
