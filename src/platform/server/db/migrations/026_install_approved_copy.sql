-- Whether what a practice runs is what the platform owner approved.
--
-- An installed app is a copy of its catalogue entry. When a developer edits an
-- approved entry it goes back for review, but the practices keep running the copy
-- that was approved, so the entry's status alone cannot say whether the copy is.
ALTER TABLE catalogue_install ADD COLUMN IF NOT EXISTS approved_copy BOOLEAN NOT NULL DEFAULT false;

UPDATE catalogue_install i
SET approved_copy = true
FROM catalogue_app a
WHERE a.id = i.catalogue_id AND a.status = 'godkjent';
