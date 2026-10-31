-- Lets an app be launched in its own browser window instead of a frame.
--
-- A framed app is a third-party context: the top-level page belongs to the
-- record, so the app's own cookies are third-party cookies, and browsers now
-- block those by default. An app that keeps a session cookie between its launch
-- endpoint and its redirect target therefore loses it halfway through the
-- SMART handshake and fails after authorisation has already succeeded - a
-- failure that looks like the record's fault and is not.
--
-- Apps can fix this for themselves with the Partitioned attribute (CHIPS) or
-- the Storage Access API, but that is their release cycle, not ours. Opening
-- the app as its own top-level document makes its cookies first-party again and
-- needs nothing from the vendor.
--
-- Off by default: the frame keeps the patient banner, the tabs and the task
-- panel in view, which is the better consultation when the app can take it.

ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS open_in_new_tab BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN oauth_client.open_in_new_tab IS
  'Whether the app opens in its own browser window rather than in a frame inside the record, so that its cookies are first-party.';
