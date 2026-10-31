-- Links a user account to the person's national identity number.
--
-- HelseID identifies a person by `pid` - the fødselsnummer, the Norwegian
-- national identity number. Until now an account was linked on HPR number,
-- which only works for registered health personnel: a medical secretary or an
-- office manager has no HPR number, so there was nothing to pre-register them
-- against. Everyone at a practice has a fødselsnummer.
--
-- The number is a direct personal identifier and is treated as such: it is
-- unique within the organisation, and never used as a username or shown where a
-- name would do.

ALTER TABLE user_account ADD COLUMN IF NOT EXISTS national_id TEXT;

COMMENT ON COLUMN user_account.national_id IS
  'Fødselsnummer (Norwegian national identity number), as HelseID''s pid claim.';

-- Unique per organisation, like the other identifiers on the account. The same
-- person may hold an account at several practices.
CREATE UNIQUE INDEX IF NOT EXISTS user_account_tenant_national_id_key
  ON user_account (tenant_id, national_id)
  WHERE national_id IS NOT NULL;
