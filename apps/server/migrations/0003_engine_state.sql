-- Engine-owned state (see `packages/core/src/db/schema.ts`): what the engine
-- last worked out per review and per repo. Homebase and the API only read it.
CREATE TABLE review_state (
  review_id        text PRIMARY KEY NOT NULL REFERENCES review (id) ON DELETE CASCADE,
  version          integer NOT NULL,
  head_sha         text NOT NULL,
  base_sha         text NOT NULL,
  head_source      text NOT NULL,
  merged           integer NOT NULL,
  files_total      integer NOT NULL,
  additions        integer NOT NULL,
  deletions        integer NOT NULL,
  -- JSON `{ [path]: newBlob }`.
  blob_by_path     text NOT NULL,
  subject          text,
  author_name      text,
  committed_at     integer,
  -- JSON `PullDetail`.
  pull             text,
  pull_head_sha    text,
  pull_updated_at  text,
  merged_base_sha  text,
  updated_at       integer NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE repo_state (
  repo_id    text PRIMARY KEY NOT NULL REFERENCES repo (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  -- JSON `ListOpenPullsResult`.
  pulls      text NOT NULL,
  polled_at  integer NOT NULL DEFAULT (unixepoch())
);

-- Superseded by the tables above: the old Homebase stats and pull caches.
DELETE FROM cache_entry WHERE key LIKE 'reviewStats@%' OR key LIKE 'pulls@%' OR key LIKE 'pull-detail@%';
