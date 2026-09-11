-- Fewer roles, named after access rather than profession.
--
-- There were thirteen, one per professional title, and between several of them
-- there was no difference at all in what they could see: lege, lege-vikar,
-- turnuslege, sykepleier, jordmor and psykolog all had the same access. A
-- distinction the system never acts on is not a distinction - it is a longer
-- list to get wrong when somebody is given a role.
--
-- Four remain at a practice, plus the patient's own access and the platform
-- role that belongs to no practice.
--
-- Note what this merge does: everyone who could give care now holds one role,
-- and that role can prescribe. Prescribing is restricted by law to particular
-- professions, and a model built on access does not know professions. The
-- record holds an HPR number; gating on that is the fix, not thirteen roles.

UPDATE role_assignment SET role = 'behandler'
 WHERE role IN ('lege', 'lege-vikar', 'turnuslege', 'sykepleier', 'jordmor', 'psykolog');

UPDATE role_assignment SET role = 'lab' WHERE role = 'bioingenior';

UPDATE role_assignment SET role = 'resepsjon' WHERE role IN ('helsesekretaer', 'regnskap');

-- The data protection officer's job is reviewing the log, which systemansvarlig
-- can already do. What is not carried over is that role's ability to open any
-- record without a care relationship - an oversight function does not need to
-- read records, and systemansvarlig deliberately cannot.
UPDATE role_assignment SET role = 'systemansvarlig' WHERE role = 'personvernombud';

-- The merge can leave the same person holding one role twice.
DELETE FROM role_assignment a
 USING role_assignment b
 WHERE a.user_id = b.user_id
   AND a.role = b.role
   AND a.valid_until IS NULL
   AND b.valid_until IS NULL
   AND a.id > b.id;
