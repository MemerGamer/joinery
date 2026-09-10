# Improvements

## git layer

- **No `git fetch` support in `run.ts`'s allowlist.** SPEC §5 "Detectors"
  describes a remote poll (`git fetch --no-write-fetch-head` for the PR ref
  and `refs/remotes/origin/<default>`) as part of the engine, and SPEC §4
  describes fetching `refs/pull/<N>/head`. Neither `fetch` nor any other
  network-touching subcommand is in `READ_ONLY_SUBCOMMANDS` in
  `apps/server/src/git/run.ts`, and the SPEC §5 "Concurrency and safety" write
  allowlist text (`worktree add --detach`, scoped worktree deletion,
  `update-ref refs/review/*`) doesn't mention fetch either, so it's ambiguous
  whether fetch belongs in this layer at all. None of the 9 modules in this
  task's brief call for a fetch wrapper, so it was left out; whatever
  implements the remote poll will need to add `fetch` to the allowlist (with
  its own argument-shape validation, since an unscoped fetch can write
  arbitrary refs) and a thin wrapper function, likely in `repo.ts`.
- **`detectInProgressOperation` (`repo.ts`) can't distinguish `git am` from a
  plain rebase.** Both leave `$GIT_DIR/rebase-apply`, so a `rebase-apply`
  marker is always reported as `'rebase'`, never `'am'`, even though the
  `GitOperation` union in `@review/core` has an `'am'` member. Disambiguating
  requires reading `rebase-apply/applying` (present only for `git am`), which
  wasn't implemented — add that check if the UI ever needs to show
  "applying a patch" instead of "rebasing" specifically.
- **`defaultBranch` (`repo.ts`) only reads the local `refs/remotes/origin/HEAD`
  symref** (`git symbolic-ref refs/remotes/origin/HEAD`); it returns `null`
  if that symref was never set (e.g. a repo cloned with
  `--single-branch`/`--no-tags`, or one where `origin/HEAD` was pruned). A
  more complete implementation would fall back to `git remote show origin` or
  `git ls-remote --symref origin HEAD`, but both hit the network, and adding
  an implicit network call felt out of place in a function whose contract
  elsewhere in this module is "reads local state only." Callers that get
  `null` back should prompt for/store an explicit default branch instead.
- **Untracked-file `additions`/binary detection in `filelist.ts` is a
  heuristic, not git's own algorithm.** Untracked files never go through
  `git diff`, so `untrackedFileStats()` reimplements a simplified version of
  git's binary heuristic (NUL byte in the first 8000 bytes) and counts
  newlines for `additions`, rather than shelling out to
  `git diff --no-index /dev/null <file>` per untracked file (which would
  restore per-file spawns — exactly what SPEC §6 says never to do for blob
  reads, and the same tradeoff applies here). This can disagree with git's
  own diff on binary-detection edge cases (e.g. a large text file whose first
  8000 bytes happen to be pure ASCII but which contains a NUL further in) and
  never reproduces git's exact "no newline at end of file" bookkeeping.
- **No startup sweep of stale owned worktree registry entries.** SPEC §4 says
  "swept on review close" and "scoped registry sweep on startup" for agent
  worktrees. `worktree.ts` exports the primitive `scopedRemoveWorktree` (safe,
  scoped deletion of one worktree we created) but not a function that
  enumerates `$GIT_COMMON_DIR/worktrees/*` and filters to the ones under our
  `dataDir` to sweep on startup — that orchestration (plus the "which ones are
  actually stale" policy, e.g. by age or by cross-referencing the
  `agent_worktree` cache table) belongs to a higher-level module that has
  the data dir and the DB, neither of which `worktree.ts` owns.
- **No `(repo, sha)` worktree dedupe.** SPEC §4 says "two worktrees, same SHA
  ALLOWED by git — dedupe is ours to implement." `worktree.ts` only exposes
  the primitives (`createDetachedWorktree`, `findWorktreeForBranch`,
  `listWorktrees`, `scopedRemoveWorktree`); deciding "do we already have a
  worktree at this SHA" is a stateful policy question for whatever owns the
  `agent_worktree` cache table, not something this stateless primitives layer
  can answer on its own.
- **`GitError`'s `subcommand` field is just `args[0]`**, e.g. `"worktree"`
  for a failed `worktree add`, not `"worktree add"`. Fine for the current
  callers (which log/inspect the full `args` array too), but a caller that
  branches only on `.subcommand` won't be able to tell a failed `worktree add`
  from a failed `worktree list` without also inspecting `.args`.
- **`readStatus`/`parsePorcelainStatusV2` (`status.ts`) is a parser only — it
  is not wired into a debounced "tick" actor.** SPEC §5 describes ticks
  (150 ms trailing debounce, 1 s ceiling, one engine actor per review,
  serialized with a dirty flag for events arriving mid-tick) as the thing that
  calls `git status`, diffs the resulting `FileList` against the previous one,
  and pushes a delta. None of that orchestration exists in `apps/server/src/git/`
  — by design, per this task's brief, which asked for the git primitives
  (`status.ts`, `filelist.ts`, etc.) rather than the engine actor that calls
  them on a schedule. The two recursive filesystem watches (root watch,
  git watch) described in SPEC §5 "Detectors" are also not implemented here
  for the same reason — this layer has no watcher, just on-demand git calls.

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

## web

- **`vite.config.ts` had to be edited to unblock the build.** It imported
  `DEFAULT_PORT` from `@review/core`, whose `package.json` "exports" point
  straight at `.ts` source. `vite.config.ts` is loaded by Node's native ESM
  loader (not Vite's own transform pipeline), which can't resolve a bare
  `.ts` file and fails with `ERR_UNKNOWN_FILE_EXTENSION` — reproduced with
  both `bun run --filter '@review/web' build` and `bun run vite build`
  directly, so it isn't specific to the filter invocation. Fixed by inlining
  the port literal (`7317`) in `apps/web/vite.config.ts` with a comment
  explaining why, rather than importing it. If `@review/core` ever ships a
  compiled `dist/` with a `.js`/`.d.ts` exports entry, the import can be
  restored.
- **Per-file patches are fetched eagerly in file-list order, not lazily by
  viewport.** SPEC §6 wants patches fetched "on demand in viewport and
  reading-order sequence." `ReviewContext.rebuildOrder` (`apps/web/src/state/ReviewContext.tsx`)
  instead kicks off `loadFileDiff` for every un-hydrated file as soon as the
  file list loads. Doing true viewport-driven fetching needs either an
  `IntersectionObserver` wired to each rendered `CodeView` item's DOM node
  (available via `CodeViewHandle.getInstance().getRenderedItems()`, the same
  API the anchor-capture code already uses) or a scroll-position subscription
  via `CodeView`'s `onScroll`/`subscribeToScroll`, cross-referenced against
  reading-order sequence for prefetch-ahead. Given the size of everything else
  in scope this was left as eager-but-cached (still one request per file, still
  cached by blob-SHA pair, never a re-fetch) rather than half-implemented.
- **Large-file collapse threshold approximates "2,000 lines" with
  `additions + deletions`, and the 500 KB byte-size half of the rule isn't
  checked at all.** `isLargeFile` in `ReviewContext.tsx` — `FileEntry`
  (`packages/core/src/domain/files.ts`) carries `additions`/`deletions` but no
  line count or byte size, so there's nothing else to check against before
  the patch itself has loaded (at which point `fileDiff.hunks`/`additionLines`
  would give an exact count, but by then the collapse decision has already
  been made once for the placeholder). A proper fix likely means the file
  list response carrying a byte-size/line-count hint per entry, or deferring
  the collapse decision until the first patch fetch resolves.
- **No viewport-driven prefetch on scroll**, and hunk-level `j`/`k` navigation
  (SPEC §11) is a documented no-op stub in `apps/web/src/components/ReviewWindow.tsx`
  (`nextHunk`). `CodeView`'s public `CodeViewHandle` doesn't expose a
  "current/next hunk" concept directly — it would need to be built on top of
  `scrollTo({type:'position', ...})` plus reading hunk boundaries out of each
  item's `fileDiff.hunks`, tracking which hunk is nearest the current scroll
  position. `prevHunk`, `nextThread`/`prevThread`, and `expandHunk`/
  `expandWholeFile` (`e`/`Shift+E`) are likewise wired into
  `useGlobalKeymap`'s action table in `ReviewWindow.tsx` but have no handler
  passed in yet — `e`/`Shift+E` need to resolve "the hunk under the cursor",
  which needs the same missing hunk-position tracking.
- **Viewport anchoring restores file-level position only, not
  `(path, side, line)`.** SPEC §5 wants the exact topmost visible line
  restored after a delta. `captureTopVisiblePath`/`applyPendingRefresh` in
  `ReviewContext.tsx` measure rendered item elements' `getBoundingClientRect()`
  against the scroll container to find the topmost visible *file* and
  `scrollTo({type:'item', ...})` it back into view, with a reading-order
  nearest-neighbor fallback if that file was removed. Getting to exact line
  granularity needs either a line-level DOM query inside each item's shadow
  DOM (undocumented internals) or a Pierre API for "line nearest a given pixel
  offset," which isn't part of the public `CodeViewHandle` surface.
- **No resizable pane splitters.** The three panes (`ReviewWindow.tsx`) are
  fixed-width (`w-60`/`w-72`) rather than drag-resizable. Base UI doesn't ship
  a resizable-panel primitive; this would need a small custom pointer-drag
  hook or a dedicated library, neither of which was in the installed
  dependency set, so it was left out rather than hand-rolled under time
  pressure.
- **`@pierre/trees` row decorations use plain text (`✓`, `gen`), not icons.**
  `FileTreePane.tsx`'s `renderRowDecoration` returns `FileTreeRowDecoration`,
  whose icon variant takes a `RemappedIcon` (a sprite-sheet icon *name* from
  `@pierre/trees`' own icon config, not an arbitrary React node), so a
  `lucide-react` icon can't be dropped in directly without building/wiring a
  custom sprite sheet via `iconConfig.spriteSheet`. Left as short text labels
  rather than take on sprite-sheet generation.
- **Command palette's "ask agent" action (SPEC §11) is not implemented.**
  `CommandPalette.tsx` covers jump-to-file/step/thread/review, revision
  switch, theme switch, and generate-reading-order, but "ask agent" needs a
  selected thread as context (there's no "ask agent about nothing" flow) and
  the palette currently has no notion of a currently-open thread to attach
  the action to. `ThreadArticle.tsx`'s "Ask agent" button (inside the reply
  composer) covers the equivalent action once a thread is open; the palette
  entry point was left out rather than fabricate a "pick a thread first"
  sub-flow.
- **`review.branch` header identity and Homebase repo path both fall back to
  the raw id when data is missing**, e.g. `review.pinnedSha?.slice(0, 10) ??
  'detached'` in `Homebase.tsx`/`Header.tsx` — reasonable placeholders, but
  not validated against what the server actually returns for a `(repo, sha)`
  review that hasn't adopted a branch yet.
- **No axe/screen-reader audit was run** (that's explicitly P4.5 in SPEC §12,
  after this pass) — landmarks, `aria-label`s, and focus rings were applied
  by hand per SPEC §3's checklist (Base UI primitives weren't pulled in for
  the threads panel or command palette dismiss behavior — `cmdk`'s
  `Command.Dialog` supplies its own via the `@radix-ui/react-dialog` it
  depends on, but the threads panel in `ThreadsPanel.tsx` is a plain
  `role="region"` panel with a manual close button rather than a Base UI
  `Dialog`/`Popover`, so it doesn't get automatic focus-trap/restore — it's a
  non-modal overlay by design (it doesn't block interaction with the diff
  behind it), but keyboard focus doesn't currently move into it on open).
- **Split vs unified (`u`) and panel toggles are wired through
  `useGlobalKeymap`, but text-input contexts aren't specially excluded**
  beyond `tinykeys`' own `defaultKeybindingsHandlerIgnore` (ignores events
  from `contenteditable`/form elements unless they're the event target) — this
  should be correct for the comment composer's `<textarea>`, but wasn't
  explicitly tested against every single-letter binding (`j`, `k`, `n`, `p`,
  `c`, `r`, `t`, `u`, `e`, `v`) firing while a modal/dialog other than the
  composer has focus.
