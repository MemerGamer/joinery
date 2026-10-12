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
