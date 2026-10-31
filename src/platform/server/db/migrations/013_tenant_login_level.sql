-- How strongly a user must prove who they are, per organisation.
--
-- The three ways in are not equally strong, and which is good enough is not
-- ours to decide for everyone. A practice with real patients should require
-- HelseID at security level 4; a trial with synthetic data would be unusable
-- if it did, since nobody gets a HelseID to look at made-up people.
--
-- The values are ordered, and the setting is a floor rather than a choice of
-- method: 'epost' lets anything in, 'passord' rules out an emailed code, and
-- 'helseid' rules out everything but HelseID.
--
--   epost    a code to an address. Proves someone reads mail there, no more.
--   passord  username, password and a one-time code from an authenticator.
--   helseid  HelseID at security level 4.
--
-- The default is 'passord' - the middle one - because it is what the existing
-- organisations already use, and a migration should not quietly lock anyone
-- out or quietly let anyone in.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS login_level TEXT NOT NULL DEFAULT 'passord';

COMMENT ON COLUMN tenant.login_level IS
  'Lowest acceptable sign-in method: epost, passord or helseid.';
