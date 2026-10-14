-- Initial schema. Hand-reviewed; generated as a starting point with
-- `bunx drizzle-kit generate` from packages/core/src/db/schema.ts, the single
-- source of truth for tables. Tables are ordered so every foreign key points
-- at a table already created.

CREATE TABLE repo (
  id              text PRIMARY KEY NOT NULL,
  root_path       text NOT NULL,
  remote_host     text,
  remote_owner    text,
  remote_name     text,
  default_branch  text NOT NULL,
  created_at      integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX repo_root_path_idx ON repo (root_path);

CREATE TABLE review (
  id                 text PRIMARY KEY NOT NULL,
  repo_id            text NOT NULL REFERENCES repo (id) ON DELETE CASCADE,
  branch             text,
  pinned_sha         text,
  base_ref           text NOT NULL,
  pr_number          integer,
  -- 'working' | 'head' | 'pr'. NULL means the user has never picked a
  -- revision, so the default applies (`working` when the branch is attached on
  -- disk, `head` otherwise). Without a "not chosen" state the engine could not
  -- tell a stored default from a deliberate choice, and would silently flip an
  -- explicit `head` back to `working` the moment a branch is checked out again.
  current_revision   text,
  last_seen_pr_sha   text,
  -- Homebase "unread agent replies": agent comments created after this count
  -- as unread; NULL (never opened) means every agent comment counts.
  -- `GET /api/reviews/:id` sets it to `unixepoch()` after building its response.
  last_opened_at     integer,
  status             text NOT NULL DEFAULT 'open',
  created_at         integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX review_repo_branch_idx ON review (repo_id, branch);
CREATE INDEX review_repo_idx ON review (repo_id);

CREATE TABLE agent_worktree (
  repo_id       text NOT NULL REFERENCES repo (id) ON DELETE CASCADE,
  sha           text NOT NULL,
  path          text NOT NULL,
  created_at    integer NOT NULL DEFAULT (unixepoch()),
  last_used_at  integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (repo_id, sha)
);

CREATE TABLE reading_order (
  id            text PRIMARY KEY NOT NULL,
  review_id     text NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  agent_run_id  text,
  created_at    integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX reading_order_review_idx ON reading_order (review_id);

CREATE TABLE step (
  id                text PRIMARY KEY NOT NULL,
  reading_order_id  text NOT NULL REFERENCES reading_order (id) ON DELETE CASCADE,
  idx               integer NOT NULL,
  title             text NOT NULL,
  guidance          text NOT NULL DEFAULT '',
  attention         text
);

CREATE UNIQUE INDEX step_order_idx ON step (reading_order_id, idx);

CREATE TABLE step_file (
  step_id  text NOT NULL REFERENCES step (id) ON DELETE CASCADE,
  idx      integer NOT NULL,
  path     text NOT NULL,
  note  text,
  PRIMARY KEY (step_id, idx)
);

-- Keyed by blob SHA, so a changed blob simply fails to match and the check
-- clears itself. There is no invalidation code.
CREATE TABLE file_viewed (
  review_id  text NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  path       text NOT NULL,
  blob_sha   text NOT NULL,
  viewed_at  integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (review_id, path, blob_sha)
);

CREATE TABLE thread (
  id                     text PRIMARY KEY NOT NULL,
  review_id              text NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  path                   text NOT NULL,
  side                   text NOT NULL,
  start_line             integer NOT NULL,
  end_line               integer NOT NULL,
  anchor_blob_sha        text NOT NULL,
  anchor_context_hash    text NOT NULL,
  anchor_context         text NOT NULL DEFAULT '',
  status                 text NOT NULL DEFAULT 'open',
  outdated               integer NOT NULL DEFAULT 0,
  changed_since_comment  integer NOT NULL DEFAULT 0,
  created_at             integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX thread_review_path_idx ON thread (review_id, path);

CREATE TABLE comment (
  id             text PRIMARY KEY NOT NULL,
  thread_id      text NOT NULL REFERENCES thread (id) ON DELETE CASCADE,
  author         text NOT NULL,
  body        text NOT NULL,
  agent_run_id   text,
  created_at     integer NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX comment_thread_idx ON comment (thread_id, created_at);

CREATE TABLE agent_run (
  id             text PRIMARY KEY NOT NULL,
  review_id      text NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  thread_id      text REFERENCES thread (id) ON DELETE CASCADE,
  kind           text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  session_id     text,
  resume_cursor  text,
  started_at     integer NOT NULL DEFAULT (unixepoch()),
  ended_at       integer,
  error          text
);

CREATE INDEX agent_run_review_idx ON agent_run (review_id);

CREATE TABLE agent_event (
  run_id      text NOT NULL REFERENCES agent_run (id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL,
  payload     text NOT NULL,
  created_at  integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (run_id, seq)
);

-- Reactions on comments: one row per `(comment, actor, kind)`. Toggling a
-- reaction off simply deletes its row, so the table carries no identity of its
-- own beyond that triple.
CREATE TABLE reaction (
  comment_id  text NOT NULL REFERENCES comment (id) ON DELETE CASCADE,
  actor       text NOT NULL,
  kind        text NOT NULL,
  created_at  integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (comment_id, actor, kind)
);

CREATE INDEX reaction_comment_idx ON reaction (comment_id);

-- Last known answers for things computed from git or `gh` (open pulls per
-- repo, git stats per review, the `gh` login), so Homebase can answer from
-- them at once — across restarts too — while fresh ones are fetched behind
-- them. A cache, not state: deleting every row costs one blocking fetch per
-- key. Keys are namespaced (`pulls:<repoId>`, `reviewStats:<reviewId>`, `me`).
CREATE TABLE cache_entry (
  key         text PRIMARY KEY NOT NULL,
  -- JSON.
  value       text NOT NULL,
  -- Milliseconds since epoch, unlike the `unixepoch()` seconds elsewhere: it
  -- is compared against `Date.now()` for staleness.
  fetched_at  integer NOT NULL
);
