-- App-wide preferences, as JSON by key: which language server to run per
-- language (`lsp.choice.<language>`). Not a cache: never pruned or cleared.
CREATE TABLE app_setting (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL
);
