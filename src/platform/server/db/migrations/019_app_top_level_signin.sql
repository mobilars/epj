-- Lets an app sign the user in as a top-level window before it is framed.
--
-- Some apps authenticate against an identity provider of their own on the way
-- in. HelseID is one. Identity providers refuse to be framed, and they are
-- right to: an authorization endpoint rendered inside someone else's page is a
-- clickjacking target, so the login page carries X-Frame-Options and the frame
-- goes blank exactly where the user would have typed their credentials.
--
-- Note what is and is not refused. `/connect/authorize` answers with a
-- redirect and renders nothing; only the login page behind it is a document.
-- So an app whose provider already has a session passes through a frame on
-- redirects alone, and nothing is there to be blocked.
--
-- That is the opening. The record launches the app in its own window first,
-- where the provider is top level and free to draw whatever it needs: a login
-- form, an organisation choice, a step up in security level. Once the user is
-- through, the same app is framed, the provider recognises the session, and the
-- consultation carries on with the patient banner and tabs still in view. The
-- vendor changes nothing.
--
-- It does rest on the provider's session cookie being sent from a framed
-- context. Where a browser blocks third-party cookies outright, the app needs
-- its own window (`open_in_new_tab`) or a fix on its own side.

ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS top_level_signin BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN oauth_client.top_level_signin IS
  'Whether the record signs the user in through a window of its own before framing the app, for apps whose identity provider refuses to be framed.';

-- The two flags are one choice with three answers, so the pair that means both
-- at once is not a state the record should ever have to interpret.
ALTER TABLE oauth_client DROP CONSTRAINT IF EXISTS oauth_client_one_launch_mode;
ALTER TABLE oauth_client ADD CONSTRAINT oauth_client_one_launch_mode
  CHECK (NOT (open_in_new_tab AND top_level_signin));
