-- SMART-apper som startes fra journalen (EHR launch) må registrere en
-- launch-URL. Journalen sender brukeren dit med `iss` og `launch`, og appen
-- henter selv oppsettet fra /.well-known/smart-configuration.
ALTER TABLE epj.oauth_client ADD COLUMN IF NOT EXISTS launch_url TEXT;
