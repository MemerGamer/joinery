-- `current_revision` becomes nullable: NULL means the user has never picked a
-- revision, so the default applies (`working` when the branch is
-- attached on disk, `head` otherwise). Without a "not chosen" state the engine
-- cannot tell a stored default from a deliberate choice, and would silently
-- flip an explicit `head` back to `working` the moment a branch is checked out
-- again — exactly the flip that must never happen.
--
-- SQLite cannot drop a NOT NULL constraint in place, but dropping and re-adding
-- an unindexed column is a supported ALTER, so the value round-trips through a
-- temporary column.
ALTER TABLE review ADD COLUMN revision_choice text;

-- Rows written before this migration could not distinguish the two, and every
-- one of them carries the old column default. Treat the default as "not
-- chosen" and keep anything else, which is the only reading that cannot
-- fabricate a choice the user never made.
UPDATE review SET revision_choice = NULLIF(current_revision, 'head');

ALTER TABLE review DROP COLUMN current_revision;
ALTER TABLE review ADD COLUMN current_revision text;
UPDATE review SET current_revision = revision_choice;
ALTER TABLE review DROP COLUMN revision_choice;

-- Root attachment is resolved from git on every tick. Persisting it
-- stored a copy that goes stale the moment anything happens while the server is
-- down, and nothing ever read it — `ReviewState.root.attachedPath` is the live
-- value the API and UI use.
ALTER TABLE review DROP COLUMN attached_path;
