-- ---------------------------------------------------------------------------
-- Multitenancy.
--
-- Én installasjon betjener flere virksomheter (legekontorer). Hver virksomhet
-- er en «tenant» med egen HAPI FHIR-partisjon, egne brukere, egen
-- sikkerhetslogg og egne signeringsnøkler.
--
-- Kliniske data skilles av HAPI sin partisjonering. Alt i dette skjemaet
-- skilles av `tenant_id`, som er obligatorisk på alle tabeller som kan
-- inneholde virksomhetsdata.
-- ---------------------------------------------------------------------------

SET search_path TO epj, public;

CREATE TABLE IF NOT EXISTS tenant (
  -- Kort maskinnavn. Brukes også som partisjonsnavn i HAPI FHIR, og inngår
  -- derfor i FHIR-URL-er: /fhir/<tenant>/Patient
  id                  TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  navn                TEXT NOT NULL,
  organisasjonsnummer TEXT NOT NULL,
  her_id              TEXT,
  kommunenummer       TEXT,
  -- Vertsnavnet virksomheten nås på. Tenant utledes fra dette ved hver
  -- forespørsel, slik at brukere aldri velger virksomhet selv.
  vertsnavn           TEXT UNIQUE,
  -- Utadvendt adresse. Brukes som `issuer` i OAuth-metadata for virksomheten.
  base_url            TEXT NOT NULL,
  -- Partisjons-id i HAPI FHIR. Settes ved opprettelse og endres aldri.
  -- NULL for systemvirksomheter som ikke har kliniske data.
  partisjon_id        INTEGER UNIQUE CHECK (partisjon_id > 0),
  status              TEXT NOT NULL DEFAULT 'aktiv'
                        CHECK (status IN ('aktiv', 'suspendert', 'avviklet')),
  merknad             TEXT,
  opprettet           TIMESTAMPTZ NOT NULL DEFAULT now(),
  opprettet_av        TEXT,
  oppdatert           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_vertsnavn ON tenant (vertsnavn) WHERE status = 'aktiv';

-- Standardvirksomhet for installasjoner som allerede er i drift, og for
-- utvikling. Alle eksisterende rader knyttes til denne.
INSERT INTO tenant (id, navn, organisasjonsnummer, her_id, base_url, partisjon_id, merknad)
VALUES ('standard', 'Standardvirksomhet', '999999999', '8000001',
        'http://localhost:5173', 1,
        'Opprettet automatisk ved innføring av multitenancy.')
ON CONFLICT (id) DO NOTHING;

-- Plattformen selv er også en «virksomhet», men uten klinisk innhold. Den
-- finnes for at plattformadministratorenes handlinger skal ha et sted å
-- loggføres, slik at sikkerhetsloggen kan være obligatorisk overalt.
INSERT INTO tenant (id, navn, organisasjonsnummer, base_url, partisjon_id, status, merknad)
VALUES ('plattform', 'Plattformadministrasjon', '999999999',
        'http://localhost:5173', NULL, 'aktiv',
        'Systemvirksomhet. Har ingen FHIR-partisjon og ingen kliniske data.')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- `tenant_id` på alle tabeller som kan inneholde virksomhetsdata.
--
-- Kolonnen legges til uten NOT NULL, fylles for eksisterende rader, og settes
-- deretter til NOT NULL. Da virker migrasjonen både på tomme og fylte baser.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  tabeller TEXT[] := ARRAY[
    'audit_event', 'care_relationship', 'break_glass', 'journal_sperring',
    'oauth_client', 'oauth_authorization_code', 'oauth_token', 'smart_launch',
    'signing_key', 'melding', 'sfm_synk', 'regningskort', 'oppgjor',
    'egenandel_oppslag'
  ];
BEGIN
  FOREACH t IN ARRAY tabeller LOOP
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
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS user_account_brukernavn_key;
DROP INDEX IF EXISTS epj.idx_user_brukernavn_tenant;
CREATE UNIQUE INDEX idx_user_brukernavn_tenant
  ON user_account (tenant_id, lower(brukernavn)) NULLS NOT DISTINCT;

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

-- Meldings-id er unik per virksomhet og retning.
DROP INDEX IF EXISTS epj.idx_melding_msgid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_melding_msgid ON melding (tenant_id, retning, msg_id);

-- Signeringsnøkler er per virksomhet, siden hver virksomhet har sin egen
-- `issuer` i OAuth-metadata.
CREATE INDEX IF NOT EXISTS idx_signing_key_tenant ON signing_key (tenant_id, aktiv, opprettet DESC);

-- Regningslinjer arver virksomhet gjennom regningskortet.
-- Ratebegrensning nøkles på tekst, og har virksomheten i selve nøkkelen.
