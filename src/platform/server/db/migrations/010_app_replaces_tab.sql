-- An app can take over one of the record's own tabs.
--
-- Once the medication list and the note editor exist as apps, the record
-- carrying its own second version of each is the worst of both: two things to
-- maintain, and a practice that installs a better one still sees ours in the
-- menu. Binding an app to a tab makes the app the answer to that tab, and the
-- record's built-in page the fallback for when no app is bound.
--
-- The tab is named by the route segment it belongs to - 'notater',
-- 'legemidler' - or is null when the app takes over nothing.
ALTER TABLE oauth_client ADD COLUMN IF NOT EXISTS replaces_tab TEXT;

COMMENT ON COLUMN oauth_client.replaces_tab IS
  'Route segment of the record tab this app answers for, or null.';

-- One app per tab. Two apps claiming the same tab is not a state to render.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_client_tenant_tab_idx
  ON oauth_client (tenant_id, replaces_tab)
  WHERE replaces_tab IS NOT NULL AND status = 'aktiv';
