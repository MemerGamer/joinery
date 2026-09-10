-- Initial schema. Hand-reviewed; generated as a starting point with
-- `bunx drizzle-kit generate` from packages/core/src/db/schema.ts, the single
-- source of truth for tables. Tables are ordered so every foreign key points
-- at a table already created.

CREATE TABLE repo (
  id              text PRIMARY KEY NOT NULL,
  root_path       text NOT NULL,
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
  attached_path      text,
  current_revision   text NOT NULL DEFAULT 'head',
  last_seen_pr_sha   text,
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
  version       integer NOT NULL,
  agent_run_id  text,
  created_at    integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX reading_order_review_version_idx ON reading_order (review_id, version);

CREATE TABLE step (
  id                text PRIMARY KEY NOT NULL,
  reading_order_id  text NOT NULL REFERENCES reading_order (id) ON DELETE CASCADE,
  idx               integer NOT NULL,
  title             text NOT NULL,
  explanation_md    text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX step_order_idx ON step (reading_order_id, idx);

CREATE TABLE step_file (
  step_id  text NOT NULL REFERENCES step (id) ON DELETE CASCADE,
  idx      integer NOT NULL,
  path     text NOT NULL,
  note_md  text,
  PRIMARY KEY (step_id, idx)
);

-- Keyed by blob SHA, so a changed blob simply fails to match and the check
-- clears itself. There is no invalidation code (SPEC §5).
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
  body_md        text NOT NULL,
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
