# Improvements

## persistence

- `worktrees.ts`'s `listStaleWorktrees` finds rows by age but there is no
  paired helper to also remove the `$GIT_COMMON_DIR/worktrees/<name>` registry
  entry or `rm -rf` the directory — that's git/filesystem work that belongs
  outside `apps/server/src/db/`, so only the row-level cache API (`get`,
  `create`, `touch`, `listStale`, `delete`) is implemented here. The sweep job
  that calls `listStaleWorktrees` then does the disk/registry cleanup needs to
  live elsewhere and call `deleteWorktree` after.
- `renamePaths` rewrites `thread.path` and `file_viewed.path` atomically, but
  it is a standalone transaction — the spec asks for the rewrite to happen "in
  the same transaction that applies the file list." The file list itself is
  never persisted (SPEC §5: "the list is the key," no snapshot table), so
  there was no existing transaction to join here. Whatever module ends up
  owning the tick / file-list-apply step should call `renamePaths(db, ...)`
  from inside its own transaction if it opens one, or accept that this is a
  second, immediately-following transaction rather than a literally single
  one.
- `narrowUnion` throws on an unexpected column value instead of returning a
  typed error/Result. Given SQLite is single-writer and only this codebase
  ever writes these columns, a thrown error (crash loud, not silent
  mis-typing) seemed like the right trade-off, but it means a hand-edited DB
  row or a future migration that forgets to update a CHECK/narrowing list
  will surface as an unhandled exception rather than a graceful error path.
- No `CHECK` constraints were added in `0001_init.sql` to enforce the string
  unions (`current_revision`, `status`, `side`, `author`, `kind`) at the SQL
  level — `packages/core/src/db/schema.ts` doesn't declare them either, so the
  migration matches the source of truth exactly as instructed, but it means
  the only enforcement of those unions is `narrowUnion` on read and TypeScript
  on write.
- Bulk `updateAnchors` and `renamePaths` loop per-row inside a
  `db.transaction()` rather than using a single multi-row `UPDATE ... FROM
  (VALUES ...)`; at expected review sizes (hundreds of threads/files, not
  millions) this is fine, but it's an N-statement transaction, not O(1) SQL.

## cli

- `review create` only ever sends `repoPath: process.cwd()` to
  `POST /api/reviews` — there is no `--repo`/`--repo-id` flag, matching the
  exact CLI signature in SPEC §10 (`review create --branch <name> [--base
  <ref>]`). If the server can't resolve a repo from cwd (e.g. invoked outside
  any registered repo's tree), `create` will surface that as a normal API
  error; there's no client-side repo picker.
- `review diff`/`review feedback` build their query strings (`?path=&rev=`,
  `?format=markdown&unresolved=`) by hand in `apps/cli/src/client.ts` rather
  than through a typed route in `packages/core/src/api.ts` — `api.getDiff`
  and `api.feedback`'s `path()` builders only take the review id, so query
  params aren't part of the compile-time contract the way the body/response
  schemas are. `getDiff`'s `path`/`rev` param names do match
  `diffQuerySchema` in `packages/core/src/domain/diff.ts`, but `feedback`'s
  `unresolved` query param is a guess (the SPEC table doesn't name it, only
  the CLI's `[--unresolved]`) — if the server implements a different name,
  it's a runtime behavior gap this CLI's typecheck won't catch.
- `Api['op']['path']` is typed `(...args: never[]) => string` in core's
  `RouteDef`, so real path args (a review/thread id) aren't callable through
  it without a cast — see the `buildPath` helper in `apps/cli/src/client.ts`.
  The cast is confined to that one helper and every route/method/body/response
  still flows from `api`, but it means a route whose *id-arg count* changes
  (e.g. a route gains a second path segment) is not itself a compile error
  here, only a renamed/removed route or a body/response shape change is.
- Verification step 3 (`apps/cli/dist/review --help`) could not be run in
  this sandbox: any freshly compiled Mach-O binary (including a trivial
  "hello world" one used to isolate the issue) is killed with SIGKILL
  (exit 137) the moment it's executed here, before and after ad-hoc
  `codesign --sign -`, and with the bash tool's sandbox disabled — this
  reproduces for any `bun build --compile` output, not something specific to
  this CLI's code. `bun run --filter '@review/cli' build` does succeed and
  produces `apps/cli/dist/review` (62MB, valid arm64 Mach-O per `file`).
  The equivalent entry point was instead verified with
  `bun apps/cli/src/index.ts <args>` for `--help`, `--version`, group help,
  unknown-command/unknown-flag/missing-positional usage errors (exit 2), and
  the token-not-found path (exit 1) — all behaved as intended. Please run
  `apps/cli/dist/review --help` yourself to confirm the compiled binary
  itself launches correctly in a normal shell.

## cli (integration findings)

- `bun build --compile` produces a binary that macOS SIGKILLs (exit 137) on this
  machine — Bun 1.3.12 / Darwin 24.6.0. Reproduced with a throwaway
  `console.log` binary, and `codesign --force --sign -` refuses it with
  "invalid or unsupported format for signature", so it is not our code and not
  fixable from here. The CLI itself is verified working via
  `bun apps/cli/src/index.ts`. Before shipping a binary, retest on a newer Bun
  or ship a `bun`-shebang script instead of a compiled executable.
