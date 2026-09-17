-- Reactions on comments (§8, PLAN.md R1): one row per `(comment, actor, kind)`.
-- A user or agent toggling a reaction off simply deletes its row, so the
-- table carries no identity of its own beyond that triple.
CREATE TABLE reaction (
  comment_id  text NOT NULL REFERENCES comment (id) ON DELETE CASCADE,
  actor       text NOT NULL,
  kind        text NOT NULL,
  created_at  integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (comment_id, actor, kind)
);

CREATE INDEX reaction_comment_idx ON reaction (comment_id);
