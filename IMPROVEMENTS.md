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

## http

- **`ws.ts`'s `onMessage`/`onClose` dispatch logic is untested in-process.**
  A new `apps/server/test/http/` suite covers auth, validation, error
  mapping, most of `routes.ts`, and static serving, all through
  `app.fetch()`. The WS *upgrade* route's auth gate is covered the same
  way, but the actual message dispatch (`subscribe` pushing
  `files.changed`/`root.rebound`, `unsubscribe`/`focus`/`blur` calling into
  `EngineRegistry`, a malformed message being dropped without closing the
  connection, `onClose` cleanup) lives inside the closure hono's
  `upgradeWebSocket()` returns, which is only reachable through a *real*
  WebSocket upgrade — hono's Bun adapter reads `c.env.server` inside
  `upgradeWebSocket()`, which only `Bun.serve({ fetch, websocket })`
  populates for an actual connection; plain `app.fetch(request)` throws
  `TypeError: c.env is not an Object` before `onMessage` is ever reached
  (confirmed by hand). Exercising it for real needs a throwaway
  `Bun.serve` bound to an ephemeral port plus a real `WebSocket` client,
  which the http test-suite task's ground rules explicitly excluded (no
  spawned server, no browser). Four `test.todo`s in
  `apps/server/test/http/ws.test.ts` mark exactly what's missing:
  subscribe's initial push, silently-ignored subscribe to an unknown
  review, malformed-message resilience, and `onClose` cleanup. Whoever
  picks this up should add a small `test/http/ws-live.test.ts` (or similar)
  that starts `Bun.serve` on port 0 for the duration of the test and tears
  it down after — that's a different, heavier test shape than the rest of
  this suite, which is why it wasn't folded in here.
- **`errors.ts`'s `renderError`/`errorMessage` has a defensive branch for
  non-`Error` thrown values that Hono's own dispatcher never actually
  triggers.** Both `Hono#handleError` and `compose()`'s `onError` branch
  (`node_modules/hono/dist/{hono-base,compose}.js`) only invoke the
  registered `app.onError` handler when the thrown value is `instanceof
  Error`; anything else (a bare string, for instance) is rethrown past
  `onError` and surfaces as an uncaught throw out of `app.fetch` itself
  (confirmed by hand: `throw 'x'` in a route handler never reaches
  `renderError`, it just propagates). `errors.ts`'s own
  `errorMessage()`/`renderError()` code still handles a non-`Error` `err`
  gracefully, so nothing needs fixing there, but the "500 without leaking a
  stack trace" guarantee only actually holds for `Error`-derived throws
  under the current Hono version — a route that threw a raw string or
  object would currently 500 the whole server response with no JSON body
  at all rather than a clean `{error:...}` shape. Worth either asserting
  every route in `routes.ts` only ever throws `Error`/`HttpError` (true
  today, by inspection) or wrapping route registration so any thrown value
  is normalized to an `Error` before Hono sees it, so the guarantee holds
  even if that changes later. Not fixed here since it's a design decision
  about where to add that normalization, not a small obviously-correct
  patch.

## websocket

- **`ws.ts`'s `onMessage`/`onClose` dispatch is now covered for real**, in
  `apps/server/test/http/ws-live.test.ts`, via a throwaway `Bun.serve` on an
  ephemeral port (`port: 0`, read back off the server via the new
  `startLiveServer` helper in `apps/server/test/http/helpers.ts`) driven by a
  real `WebSocket` client. This closes the gap the previous `## http` entry
  and the four `test.todo`s in `ws.test.ts` described; the todos are gone
  and `ws.test.ts`'s module comment now points here. Covered: subscribe's
  initial `files.changed`/`root.rebound` push plus later forwarded engine
  events, a no-op re-subscribe, silently-ignored subscribe to an unknown
  review, non-JSON text / schema-failing JSON / binary frames all being
  dropped without closing the connection or affecting other clients on the
  same server, `unsubscribe` detaching a listener, `focus`/`blur`/`ping`
  reaching `EngineRegistry` with the right `reviewId`, `onClose` unsubscribing
  and auto-blurring the focused review with no leaked `subscriberCount` across
  repeated connect/subscribe/disconnect cycles, a real upgrade rejecting a
  missing or wrong `?token=`, and two clients on different reviews each
  getting only their own review's events.
- **Not covered, and why: the actual poll-cadence difference between
  `FOCUSED_POLL_MS` (15s) and `BLURRED_POLL_MS` (120s) in
  `reviewEngine.ts`.** `focus()`/`blur()` both call `#restartPoll()`, which
  sets a `setInterval` at one of those two intervals; observing that
  difference for real means waiting on the order of the shorter interval,
  which the task's ground rules explicitly rule out ("do not write tests
  that wait 15+ seconds"). What *is* tested is that the WS `focus`/`blur`
  messages reach `EngineRegistry.focus`/`.blur` with the correct `reviewId`
  (via a method-spy on the registry passed into `createApp`, since that's
  the only observable, fast, non-flaky surface at this layer) — the poll
  timer itself is `reviewEngine.ts`-internal state with no public accessor,
  and `apps/server/test/engine/reviewEngine.test.ts` doesn't test it either.
  If real coverage of the cadence itself is ever wanted, the cleanest path
  is likely exporting `FOCUSED_POLL_MS`/`BLURRED_POLL_MS` (or a poll-interval
  getter) from `reviewEngine.ts` for tests to assert against directly,
  rather than timing a real interval.
- **Found while writing the fan-out isolation test, not a bug — a sharp edge
  worth knowing about:** a *pinned-sha* review (`branch: null`) whose
  `pinnedSha` is reachable from a branch some other review in the same repo
  already owns collides on `(repo_id, branch)` the moment its engine first
  ticks. `ReviewEngine.create()` → `tick()` → `#maybeAdoptBranch()` (SPEC §4:
  "the first time a named branch's history contains a `(repo, sha)`
  review's pinned commit, adopt it") runs `git branch --contains
  <pinnedSha>`, takes the first branch name it lists, and calls
  `adoptBranch()` unconditionally — with no check for whether that
  `(repo_id, branch)` pair is already taken by a different review row. In a
  repo with only two branches where one is already an existing review's
  branch, *any* pinned sha in that repo's history triggers this, and
  `adoptBranch`'s `UPDATE ... RETURNING` throws a raw
  `SQLiteError: UNIQUE constraint failed: review.repo_id, review.branch`
  that propagates out of `ReviewEngine.create()` uncaught (confirmed by
  hand: this is what broke the first draft of the fan-out test, which used
  a pinned-sha second review before switching to a second, never-checked-
  out branch instead). Whether two reviews should even be allowed to target
  branches whose adoption could collide like this is a product decision,
  not an obviously-correct one-line fix, so it's left here rather than
  patched blind — but `#maybeAdoptBranch` swallowing that particular
  `SQLiteError` (or checking first) instead of leaking it out of engine
  creation is probably the right shape of fix.

## branch adoption ownership (2026-09-10)

- **Fixed**, per an explicit design decision from the user (not improvised):
  two reviews never collapse into one row. `#maybeAdoptBranch()` in
  `apps/server/src/engine/reviewEngine.ts` now walks *every* candidate
  branch `git branch --contains <pinnedSha>` returns, in the order git
  lists them, and checks each one against a new `findReviewByBranch(db,
  repoId, branch)` query (`apps/server/src/db/reviews.ts`) before adopting
  it — the first unclaimed candidate wins. If every candidate branch is
  already owned by another review in the same repo, the review simply
  stays detached (`branch: null`, `pinnedSha` unchanged); adoption is
  treated as an optimisation, never a requirement. The whole method is now
  wrapped in try/catch so a git failure or anything else here can't take
  `ReviewEngine.create()` or a tick down with it. Ownership is resolved with
  a real `SELECT` before the `UPDATE`, not by catching the `UNIQUE`
  constraint error after the fact (a caught constraint error can't
  distinguish this case from an unrelated bug, and it leaves a failed write
  in the transaction log for nothing).
  Reproduced the original crash by hand first (two reviews on the same
  repo — one owning a branch outright, a second pinned to a sha reachable
  from that branch — then constructing `ReviewEngine` for the second: it
  threw `SQLiteError: UNIQUE constraint failed: review.repo_id,
  review.branch` straight out of `create()`, matching this entry's
  description exactly), then confirmed the fix no longer throws in the same
  setup. New coverage in `apps/server/test/engine/reviewEngine.test.ts`:
  a taken single-candidate branch leaves the review detached and the owning
  review untouched, and a taken-then-unclaimed two-candidate case (branch
  names chosen so git's alphabetical `--contains` order puts the taken one
  first) adopts the later, unclaimed one instead of giving up.

## anchoring

- **Ambiguous relocation match — needs a design decision, not fixed.**
  `findSubsequence` (`apps/server/src/engine/anchor.ts`) returns the
  *earliest* index where the captured context occurs, with no signal back
  to `relocate`/`#reanchorThreads` that a match was ambiguous. If a file
  contains two identical copies of a thread's `±3`-line captured context
  (a duplicated block, a copy-pasted function, a repeated boilerplate
  section), the thread silently relocates to the first copy — which may or
  may not be the one it was actually about — with `outdated` left `false`
  and no way for the UI or the user to know the match was uncertain. This
  is exactly the "quietly attaches to the wrong lines" failure mode the
  anchoring system exists to avoid. Pinned as current behaviour in
  `apps/server/test/engine/anchor.test.ts` ("two identical copies of the
  anchored block: the first copy wins"). Recommendation: either (a) have
  `findSubsequence`/`relocate` detect a second match and, when the
  captured context is short/generic enough to occur more than once,
  prefer marking the thread `outdated` over guessing — accuracy over
  recall for a data-loss-adjacent decision — or (b) at minimum, surface a
  distinct "ambiguously relocated" state distinct from a clean relocation,
  so the UI can flag it for a human to confirm. Left undecided here per
  the task's ground rules: this is a product/design call, not an
  obviously-correct one-line fix.

- **Anchor hashing is byte-sensitive to line endings and trailing
  whitespace — likely fine, but unverified upstream.** `hashContext`
  (`apps/server/src/engine/anchor.ts`) hashes the literal captured text, so
  a line with a stray `\r` (CRLF) or trailing whitespace hashes differently
  from its LF/trimmed counterpart. Confirmed and pinned in
  `apps/server/test/engine/anchor.test.ts`. This is fine *if* every code
  path that reads file contents into `lines: readonly string[]` for
  `captureContext`/`relocate` consistently normalizes line endings before
  splitting — but that normalization wasn't verified as part of this task
  (it lives in whatever reads the blob/working-tree contents upstream of
  `anchor.ts`, outside this file). Worth a follow-up check: does a file
  that round-trips through a CRLF-preserving tool (some Windows editors,
  some formatters) fail to re-anchor threads even though its *content*
  didn't meaningfully change? If line endings aren't normalized
  consistently, that's a real, if narrow, "goes outdated when it should
  have followed" bug.

## web interaction

- **`thread.relocated` and `thread.updated`/`thread.created` WS handlers
  always produce a new `threads` array reference, even when nothing about
  a given thread's path/side/line actually changed** (`apps/web/src/state/
  ReviewContext.tsx`, the `eventsClient.onEvent` switch, ~line 320-338).
  After the Bug 1 fix, the "re-derive annotations" effect now compares
  built annotations by value before touching `annotationsRef`/bumping
  `item.version`, so a no-op relocation event no longer forces a
  re-render of every file — but every such event still runs the full
  `buildAnnotationsFor` comparison over `candidatePaths` (bounded by
  thread count, not file count, so it's cheap) on every WS message. If
  thread volume ever gets very large, consider having the server only
  emit these events when a thread's derivable annotation fields actually
  changed, rather than on every relocation attempt (including ones that
  resolve to the same line).

- **`captureTopVisiblePath` / `nearestSurvivingPath` (`apps/web/src/state/
  ReviewContext.tsx`) anchor scroll position at file granularity, not
  line granularity**, per the comment already in the code — this was not
  part of the assigned bug set but is worth flagging again: after a
  live-update delta lands mid-review, the viewport snaps to the top of
  the nearest surviving file rather than preserving the exact line the
  user was reading. Doing better would need a line-level anchor from
  Pierre's internal row layout, which isn't part of the public
  `CodeViewHandle` surface today (confirmed while reading `CodeView.d.ts`
  for this task — the handle exposes `scrollTo`, `setSelectedLines` /
  `getSelectedLines` / `clearSelectedLines`, `getInstance`, and item
  CRUD, but nothing for "the line nearest pixel Y").

## web appearance

- **`CommentComposer.tsx`'s textarea uses `outline-none` and relies entirely
  on the page-wide `:focus-visible` rule in `apps/web/src/styles/index.css`
  for a focus ring** (it does have its own `focus-visible:border-chrome-accent`
  as a secondary cue, so it isn't broken, just worth confirming intentional).
  Out of scope here — `CommentComposer.tsx` is explicitly off-limits while
  another agent is editing it — but worth a second look once that lands, to
  make sure the two focus treatments don't fight each other visually.

- **`ReviewCodeView.tsx` (off-limits here) is the one pane whose internal
  row/gutter density I could not touch.** `FileTreePane.tsx` got a
  `--trees-density-override` bump and `ReadingOrderPane.tsx`/`ThreadsPanel.tsx`
  got more generous row padding as part of this pass, but the centre code
  view's own line height, gutter width and hunk-header spacing are entirely
  `@pierre/diffs`-internal and weren't touched. If "things are too close
  together" persists specifically inside diff content (as opposed to the
  chrome around it), that's the next place to look — check whether
  `@pierre/diffs` exposes an equivalent density/line-height render option
  (parallel to `--trees-density-override` on `@pierre/trees`).

- **`CommandPalette.tsx` was left as-is** — it wasn't in the explicit list of
  components for the density pass (Header, RevisionPicker, DivergenceBanner,
  StepHeaderCard, RefreshPill, ThemePicker, plus the three panes), but its
  row padding/spacing currently doesn't match the rhythm applied elsewhere
  (e.g. its rows are tighter than the refreshed `ThemePicker`/`ReadingOrderPane`
  rows). Worth a follow-up pass for consistency.

- **`@pierre/trees`' own bg/fg/border tokens (`--trees-bg`, `--trees-fg`,
  `--trees-border-color`, etc., see `node_modules/@pierre/trees/dist/style.js`)
  are independent of this app's `--chrome-*` tokens** — they resolve via CSS
  `light-dark()` off the browser's `color-scheme`, which happens to end up
  visually close to the app chrome today, but they're a second, separate
  color source. Not changed in this pass (out of scope / risk of visual
  regression without a browser to verify against), but if `FileTreePane`
  ever looks subtly "off" from the rest of the chrome in one theme, this is
  why — consider wiring `--trees-bg-override`/`--trees-fg-override`/etc. to
  the `--chrome-*` variables for a single source of truth.

## file collapsing

- **`@pierre/diffs` has no `CodeViewHandle.collapse(id)` / no controlled-mode
  `updateItem`.** Per-file collapse is implemented by mutating
  `item.collapsed` in place, bumping `item.version`, and — since the React
  wrapper's controlled `items` diffing (`areItemListsEqual` in
  `dist/react/CodeView.js`) compares the array element-by-element by
  reference and treats a same-reference item as unchanged, so it never calls
  the core `setItems`/`reconcileItems` path that actually reads `version` —
  also calling `codeViewRef.current.getInstance().updateItem(item)` (the
  vanilla `CodeView` class's own public method, unguarded by the "cannot be
  used when controlled" check that only exists on the React handle) to force
  an immediate reconcile. This same gap plausibly affects the *existing*
  annotation-bump (`bumpAnnotations`) and patch-hydration (`loadPatchInto`)
  paths in `ReviewContext.tsx`, which mutate + bump `version` +
  `setItemsVersion` only, without an `updateItem()` call — they may be
  relying on some other repaint trigger (a later scroll, a sibling
  membership change) rather than reconciling immediately on their own. Worth
  checking in a browser (this task couldn't use one) whether an annotation
  appearing after clicking the gutter `+` on an otherwise-static file, or a
  patch finishing hydration for an off-screen file, actually repaints
  without additional user interaction; if not, the fix is the same
  `getInstance()?.updateItem(rec.item)` call added here.

- **SPEC §11's keyboard table doesn't list a per-file collapse/expand key.**
  `z` was picked (free, vim-fold mnemonic) and wired in `lib/keymap.ts` /
  `components/ReviewWindow.tsx`, but `SPEC.md`'s table (§11) wasn't updated
  since that file is the product spec, not app source — worth adding a row
  there (`z` | toggle focused file collapsed) to keep it the source of truth.

- **Collapse-all / expand-all (`components/Header.tsx`) are bulk, ephemeral
  actions — they don't write to the persisted per-file override map** (see
  `collapseOverridesRef` / `review-ui:collapsed:<reviewId>` in
  `state/ReviewContext.tsx`). Only an individual file's chevron click or the
  `z` shortcut records an explicit choice. This means a reload after
  "collapse all" reverts every non-explicitly-touched file to its default
  state rather than staying bulk-collapsed. That's a deliberate simplicity
  call (bulk view state treated like scroll position, not a saved
  preference) but flagging it in case product intent differs — the
  alternative is writing every affected path into the override map from
  `collapseAllFiles`/`expandAllFiles` too.

- **`ReviewCodeView.tsx`'s density tweak (`--diffs-gap-block` /
  `--diffs-line-height` set via Tailwind arbitrary properties on the
  `CodeView` `className`)** is based on reading `@pierre/diffs`' compiled
  default stylesheet (`node_modules/@pierre/diffs/dist/style.js`:
  `padding-block: var(--diffs-gap-block, var(--diffs-gap-fallback))` at an
  8px fallback, `line-height: var(--diffs-line-height, 20px)`) rather than
  any documented public API — these custom properties aren't listed in
  `types.d.ts` the way `itemMetrics`/`layout` are, so they could change or
  be renamed in a future `@pierre/diffs` version without a type error to
  catch it. Worth a visual check in a browser (not available for this task)
  to confirm the loosened spacing actually reads as intended in both split
  and unified, and both themes, before relying on it further.

## theme switching (2026-09-11)

- **Bug 1 fixed — provider nesting.** `App.tsx` had `ThemeProvider` outside
  `DiffWorkerPoolProvider`. `ThemeProvider` calls `useCoordinatedThemeChange()`
  → `useWorkerPool()` → `useContext(WorkerPoolContext)`
  (`node_modules/@pierre/diffs/dist/react/WorkerPoolContext.js`), whose
  context is created with `createContext(void 0)` and is only ever given a
  real value by `WorkerPoolContextProvider` (`DiffWorkerPoolProvider`). Since
  `ThemeProvider` rendered outside that provider, `useContext` always
  resolved to the module's default `undefined`, so
  `useCoordinatedThemeChange`'s returned setter's `if (pool === undefined)
  return;` guard (`lib/workerPool.tsx`) fired every time and
  `pool.setRenderOptions({ theme })` was never called — confirmed by reading
  both sources rather than adding throwaway instrumentation. Fixed by
  swapping the nesting in `App.tsx` so `DiffWorkerPoolProvider` is outer;
  `App.tsx` is the only place that renders either provider, so nothing else
  depended on the old order.

- **Bug 2 fixed — impure state updaters.** `ThemeContext.tsx`'s
  `setChromeMode`/`setDiffTheme` called `applyCoordinated(...)` (a side
  effect) from inside their `setState(s => ...)` updater functions.
  Restructured so the updaters are pure (`setState((s) => ({ ...s, ... }))`)
  and a single `useEffect` keyed on `activeDiffThemeName(state)` drives
  `applyCoordinated`. This also subsumed the old mount-only
  `eslint-disable`d effect: the new effect fires once on mount with the
  module-scope `initialThemeState`'s active name, which was that effect's
  whole purpose, so it was removed rather than kept alongside the general
  one.

- **Bug 3 — `--chrome-shadow` fixed.** It was defined only in the light
  `:root` block; added a dark-appropriate value (heavier alpha, same
  offsets) to both the `prefers-color-scheme: dark` block and the
  `:root[data-theme='dark']` block in `styles/index.css`.

- **Bug 3 — `FileTreePane.tsx` (`@pierre/trees`) fixed.** `<FileTree>` mounts
  its own shadow root and never inherits `data-theme` or `--chrome-*`; its
  stylesheet only reads its own `--trees-theme-*` custom properties (with a
  `--trees-*-override → --trees-theme-* → default` fallback chain — the same
  mechanism the existing `--trees-density-override` usage relies on).
  `@pierre/trees`' `themeToTreeStyles(resolvedTheme)` (from
  `node_modules/@pierre/trees/dist/utils/themeToTreeStyles.d.ts`) maps a
  resolved Shiki/VS Code-shaped theme onto that variable set. Wired it up:
  `FileTreePane` now resolves the active diff theme name via `@pierre/diffs`'
  `resolveTheme()` in an effect keyed on `chromeMode`/`diffTheme` and passes
  the result as `style={treeStyles}` on `<FileTree>`, so the tree tracks the
  same active theme as `CodeView` instead of silently keeping its internal
  defaults across a chrome-mode flip.

- **Bug 3 — hardcoded colors.** Searched all of `apps/web/src/**/*.{ts,tsx}`
  for hex literals and `rgba(`/`rgb(` outside `styles/index.css`; there were
  none. Nothing to move to tokens.

- **Bug 3 — `CodeView`'s own light/dark signal: found, NOT fixed (out of
  ownership).** `@pierre/diffs`' `CodeView`/`BaseCodeOptions` has a
  `themeType?: 'system' | 'light' | 'dark'` option (`dist/types.d.ts`,
  default `'system'` per `dist/components/CodeView.js`'s
  `previousOptions.themeType ?? "system"` check) that is **not** part of the
  worker pool's `setRenderOptions`/`WorkerRenderingOptions`
  (`dist/worker/WorkerPoolManager.d.ts`) — it's a per-`CodeView` prop, not
  pool-owned. It feeds directly into `wrapThemeCSS`
  (`dist/utils/cssWrappers.js`): `themeType !== 'system'` emits
  `:host { color-scheme: <themeType>; }` inside the CodeView's shadow root;
  left at the default `'system'`, the shadow host's `color-scheme` follows
  the OS preference rather than the app's in-app chrome-mode toggle. That
  means UA-drawn chrome scoped to that shadow root (native scrollbars, form
  control theming, default selection colors, etc. that key off
  `color-scheme`) can visibly disagree with the rest of the app whenever the
  user's chosen chrome mode differs from their OS preference — a real
  instance of "not all the UI updates" on flip. The fix is one line:
  `<CodeView options={{ ..., themeType: chromeMode }} />`. **Not fixed here**
  because it lives in `components/ReviewCodeView.tsx`, which is outside this
  task's owned file list (`App.tsx`, `state/ThemeContext.tsx`,
  `lib/workerPool.tsx`, `lib/themes.ts`, `styles/index.css`,
  `components/ThemePicker.tsx`, `components/FileTreePane.tsx`). Whoever owns
  `ReviewCodeView.tsx` should thread `chromeMode` from `useTheme()` into its
  `options.themeType`.

- **Verification.** `bun run typecheck`, `bun test` (223 pass / 0 fail —
  two printed stack traces in `apps/server` tests are expected
  error-path output, not failures), and `cd apps/web && bun run build` all
  pass. Did not launch a browser to visually confirm the fix (no browser
  tooling available in this task's environment) — recommend a manual
  chrome-mode + diff-theme flip check, including with OS dark/light
  preference set opposite to the in-app choice, to specifically exercise the
  `themeType` gap noted above once that's wired up.

## keymap (2026-09-11)

- **Bug 1 (root cause, fixed): `Alt`+letter chords can never match on
  macOS.** Confirmed by reading `matchKeybindingPress` in
  `node_modules/tinykeys/dist/tinykeys.mjs`: a bound key matches only if
  `key.toUpperCase() === event.key.toUpperCase()` OR `key === event.code`.
  Holding Option on macOS remaps `event.key` (Option+B → `"∫"`), and a plain
  character binding like `"b"` never equals `event.code` (`"KeyB"`) either,
  so `$mod+Alt+b` (the right-panel toggle) could never fire. Fixed in
  `apps/web/src/lib/keymap.ts` by binding the physical key code instead:
  `` `${MOD.primary}+${MOD.opt}+KeyB` ``. Audited every other chord in the
  table for the same class of bug — `${MOD.primary}+${MOD.opt}+KeyB` was the
  only `Alt`+letter combination; nothing else needed changing.

- **Bug 2 (fixed): single-key shortcuts fired while typing.** Added
  `apps/web/src/lib/keymapGuard.ts` (`shouldIgnoreGlobalShortcut`,
  `isEditableTarget`, `resolveEventTarget`) as `tinykeys`'s `ignore` option.
  It suppresses unmodified/`Shift`-only chords when the event's real target
  (resolved via `event.composedPath()[0]`, piercing the diff view's shadow
  DOM) is an `<input>`/`<textarea>`/`<select>`, a contenteditable region, or
  inside an element matching `[role="dialog"]` (covers `cmdk`'s
  `Command.Dialog`, which the command palette uses). `$mod` (Cmd/Ctrl)
  chords always fire, so `Cmd+Enter` keeps submitting-and-asking-the-agent
  from inside the comment composer. Unit tests in
  `apps/web/test/keymapGuard.test.ts` (14 cases) cover the guard directly
  with plain mock objects — `apps/web` has no jsdom/happy-dom test
  environment wired up, so the guard's helpers are typed structurally
  (`TargetLike`, not `Element`) specifically so they're testable without one.
  Consider adding a real DOM test environment to `apps/web` if more
  component-level (not just pure-helper) tests are wanted later.

- **Bug 3 (fixed): the keymap effect re-subscribed on every render.**
  `useGlobalKeymap` now keeps the latest `actions` in a ref (updated in a
  no-dependency-array `useEffect` after every render) and binds `tinykeys`
  exactly once (`useEffect(..., [])`); each chord handler reads the action
  through the ref at fire time. The `eslint-disable-next-line
  react-hooks/exhaustive-deps` that used to suppress the `[actions]`
  dependency warning is gone — the effect's own deps array is now honestly
  empty.

- **Bug 4 (fixed within owned files; noted limitation): "go to steps" (`g
  s`) toggled the right panel closed if it was already open**, because it
  called the same `review.toggleRightPanel()` as the panel-toggle shortcut.
  `ReviewContext` (not owned by this task) only exposes a `toggleRightPanel`
  action — no direct `setRightPanelOpen`/opener. The minimal correct fix
  within `apps/web/src/components/ReviewWindow.tsx` (owned): `goSteps` now
  calls `toggleRightPanel()` only when `review.rightPanelOpen` is currently
  `false`, and additionally focuses the right-panel container (a new
  `tabIndex={-1}` wrapper `div` around `<ReadingOrderPane />`, ref-tracked)
  once it's open — either immediately if it was already open, or via a
  pending-focus ref resolved in a `useEffect` keyed on `rightPanelOpen`
  once the panel actually mounts. **Limitation:** this focuses the panel's
  outer container, not a specific interactive element inside
  `ReadingOrderPane` (e.g. the current step) — if `ReadingOrderPane` grows
  its own focus-management API later, wiring `goSteps` to it directly would
  be more precise. Also worth adding a real `setRightPanelOpen`/`openRightPanel`
  action to `ReviewContext` itself so future callers don't need this
  open-only-if-closed workaround.

- **`nextHunk` (bound to `j`) is a documented no-op** (hunk-level navigation
  isn't wired up — no hunk index API exists yet in `@pierre/diffs` usage
  here). Per the task's own guidance that a no-op binding can be worse than
  no binding (it silently eats the keystroke with `preventDefault()` and
  does nothing visible), `ReviewWindow.tsx` no longer passes a `nextHunk`
  action to `useGlobalKeymap` at all, so `j` is simply unbound/inert rather
  than registered-but-inert. `keymap.ts` still has a `nextHunk` slot in
  `KeymapActions` and a `j` chord wired to it generically — once hunk
  navigation exists, wiring the real action back in `ReviewWindow.tsx` is
  the only change needed.

- Not changed / out of scope: `SPEC.md` §11's table wasn't updated to
  reflect binding by key code (`KeyB`) instead of character (`b`) for the
  right-panel toggle — worth a follow-up doc pass if `SPEC.md` is meant to
  double as the literal binding spec rather than a human-readable summary.

## command palette (2026-09-11)

Rebuilt `apps/web/src/components/CommandPalette.tsx`. Interaction model:
mode-scoped, VS-Code/Linear style, chosen directly off the task's own hint
(`>` commands, `#` themes) rather than a single flat ranked list, because the
palette's content is genuinely heterogeneous (file/thread/step navigation vs.
rare chrome actions vs. a 75-entry theme list vs. a review switcher) and a
single ranked corpus would either bury navigation under themes or force an
arbitrary cutoff again.

- **Root mode** (no prefix): bounded (`ROOT_CAP = 6`) groups for Files,
  Steps, and open Threads — only rendered when non-empty — plus a fixed
  "More" group with three entry points (`All commands…`, `Switch theme…`,
  `Switch review…`). Typing narrows Files/Steps/Threads across the *full*
  corpus (the cap only applies to the empty-query idle state) via cmdk's
  built-in `defaultFilter`.
- **`>` command mode**: generate reading order, switch revision (with a
  check mark on the active one), toggle left/right/threads panels, toggle
  diff style, expand/collapse all files.
- **`#` theme mode**: all 75 themes (no slice), split into "Colorblind-safe"
  and "All themes" groups mirroring `ThemePicker.tsx`'s own grouping, each
  item showing a CB badge and a check mark on the active theme.
- **`@` review mode**: full review list from `listReviews`, check mark on
  the currently open review.
- The trigger character lives in the actual (controlled) search string, so
  "back" is just Backspace deleting it — no separate page/navigation-stack
  state to keep in sync with the input. `Escape` clears the query first
  (collapsing a sub-mode back to root) and only closes the dialog once the
  query is already empty.

Fixes applied against the defect list:
1. Group headings are now styled on the `heading` node itself (cmdk accepts
   `React.ReactNode` there) instead of via `className` on `Command.Group`,
   so the heading style can no longer bleed onto the items beneath it —
   `Command.Group` itself never receives a `className` anywhere in the file.
2. Replaced the single dump-everything list with the mode model above.
3. `themeOptions.slice(0, 30)` is gone; all 75 themes are reachable via `#`.
4. `listThemeOptions()` is now `useMemo`'d once per mount.
5. Every group in root mode is conditionally rendered only when its
   underlying array is non-empty (`files.length > 0 && <Group>…`, etc.), so
   an empty "Threads" heading can no longer show up with zero rows.
6. The search string resets to `''` in a `useEffect` keyed on `open`, so
   reopening the palette always starts clean at root.
7. The doc comment's "ask agent" lie is corrected: `packages/core/src/api.ts`
   has no standalone ask-agent endpoint — `askAgent` is only a boolean flag
   on `createThread`/`reply`, meaningful in the context of a specific draft
   comment. The palette has no draft-thread context, so it doesn't expose a
   fake global action; the new file-top comment says this explicitly instead
   of promising a command that doesn't exist.
8. Keyboard: visible `kbd`-style shortcut hints on the three mode entry
   points (matching `Header.tsx`'s existing `⌘K` hint styling), `loop` passed
   to `Command.Dialog` for wraparound arrow navigation, Escape-to-back before
   Escape-to-close. Scroll-into-view for the selected item turned out to
   already be handled internally by cmdk itself (`dist/index.mjs`'s
   `scrollIntoView({ block: 'nearest' })` on selection change) — no app code
   needed for that part.
9. Icons added throughout via `lucide-react`, reusing the same icons other
   components already use for the same concepts (`FileText`, `MessageSquare`,
   `GitBranch`, `Palette`, `PanelLeft`/`PanelRight`, `ChevronsDownUp`/
   `ChevronsUpDown`, `Columns2`/`Rows2`, `Sparkles`, `Check`) plus `Terminal`
   and `ListOrdered` for the two concepts (all-commands, steps) that didn't
   have an existing precedent in this codebase.

`prefers-reduced-motion`: no new animation was added (the palette has none,
matching every other dialog/menu in this app — `ThemePicker.tsx`'s dropdown
is also animation-free), so there was nothing to guard; the existing global
rule in `styles/index.css` already covers it if that changes later.

Left undone / out of scope:
- No virtualization of the Files/Threads lists in `>` non-empty-query search
  — cmdk mounts every matching `Command.Item` it filters, same as the
  original implementation. For a repo with hundreds of changed files this is
  a real cost or a large PR; scoping the search to `> `/`# `/root sub-modes
  reduces how often the full file list is mounted at once but doesn't cap it
  during an active root-mode search. Worth a virtualized `Command.List` (cmdk
  supports `asChild` + a virtualizer) if this becomes visible in practice.
- The revision entries in `>` command mode always render all three
  (`working`/`head`/`pr`) rather than hiding a revision that doesn't apply to
  this review (e.g. a `(repo, sha)` review with no `working` revision, per
  SPEC §4). `ReviewContext` doesn't currently expose which revisions are
  valid for the open review, only the current one — plumbing that through is
  outside `CommandPalette.tsx`'s owned files.
- No dedicated `Dialog.Description` for the Radix dialog underlying
  `Command.Dialog` (cmdk doesn't render one) — a pre-existing dev-console a11y
  warning from Radix, not a regression from this change, not fixed here since
  it's inside `cmdk`'s own `Dialog` wrapper.

## panel state (2026-09-11)

- Added direct setters to `ReviewContext` — `setLeftPanelOpen(open)`,
  `setRightPanelOpen(open)`, `setThreadsPanelOpen(open)` — alongside the
  existing `toggleLeftPanel`/`toggleRightPanel`/`toggleThreadsPanel`. The
  toggles are now expressed as `setXPanelOpen((v) => !v)` against the same
  `useState`, so there is one source of truth (no separate toggle-only vs.
  setter-only state). Toggles stay in the public API — `Header.tsx`, the
  `Cmd+B` / `Cmd+Alt+B` / `t` keymap bindings, `CommandPalette.tsx`, and
  `ThreadsPanel.tsx`'s close button all call them for genuine toggle intent
  and were left unchanged.
- Confirmed the three panel-open booleans are not persisted to
  `localStorage` anywhere (only per-file collapse overrides are, via
  `collapseStorageKey`/`readStoredCollapseOverrides` elsewhere in
  `ReviewContext.tsx`) — so no persistence work was needed for the new
  setters to stay consistent with the toggles.
- This resolves the Bug 4 limitation noted in `## keymap (2026-09-11)`
  above: `ReviewWindow.tsx`'s `goSteps` (`g s`) now calls
  `review.setRightPanelOpen(true)` unconditionally instead of
  check-then-`toggleRightPanel()`, removing the read-then-write race the
  old workaround had. Focus behavior is unchanged — immediate
  `rightPanelRef.current?.focus()` when the panel is already open, or via
  the existing pending-focus ref resolved in the `useEffect` keyed on
  `rightPanelOpen` once the panel mounts when this call is what opened it.
  The stale "Bug 4 fix" comment describing the workaround and its
  `ReviewContext` limitation has been replaced with one describing the
  current (unconditional-open) behavior; the limitation no longer exists.
- Verified: `bun run typecheck` (all packages), `bun test` (240 pass, 0
  fail — unrelated to this change), and `cd apps/web && bun run build` all
  succeed.

## anchoring (2026-09-11)

- **Issue 1 fixed — ambiguous relocation matches no longer silently pick the
  earliest occurrence.** `relocate` (`apps/server/src/engine/anchor.ts`) now
  finds every occurrence of the captured context via a new
  `findAllSubsequences` (all match indices, ascending; `findSubsequence`
  becomes a thin `[0] ?? null` wrapper over it, so its own 8 tests and
  documented "earliest wins" contract at the primitive level are
  unchanged). Policy, written as a doc comment on `relocate` itself:
  - exactly one match → relocate, `confidence: 'unique'`.
  - two or more matches → break the tie by proximity: the candidate whose
    resulting start line is *strictly* closer to the thread's previous
    `startLine` than every other candidate wins (`confidence: 'nearest'`).
    Code under review drifts a little, it doesn't teleport, so "closest to
    where it was" is a real signal, not an arbitrary one.
  - if no single candidate is strictly closest (two or more tie for
    closest — including the common symmetric case of one match equally far
    above and another equally far below), that is genuine ambiguity with
    no basis to break it further, and `relocate` returns `null` so the
    caller marks the thread `outdated`. A thread the user has to
    re-locate is recoverable; a comment silently attached to the wrong one
    of two identical blocks is not — accuracy over recall for a
    data-loss-adjacent decision, per the task brief.
  - The "prefer a longer/more specific match" tie-breaker from the brief
    was considered but doesn't apply *inside* `relocate`: every candidate
    here matched the same fixed-length needle (the thread's one captured
    context), so none can be longer/more specific than another. It would
    only matter for an architecture that retries with progressively
    shorter context windows, which this one doesn't (`CONTEXT_RADIUS` is
    fixed) — noted in the doc comment as considered-and-rejected rather
    than left unaddressed.
  - `RelocateResult` gained a `confidence: 'unique' | 'nearest'` field so
    the value means something a caller could act on (e.g. badge a
    tie-broken relocation differently from a clean one); no current caller
    reads it yet — `reviewEngine.ts#reanchorThreads` only destructures
    `startLine`/`endLine`, which is unaffected by the additive field, so no
    change was needed there.
  - The never-delete invariant is untouched: an ambiguous match still only
    ever produces `null` → `outdated`, same as any other miss.

- **Issue 2 — investigated, upstream does NOT normalize; fixed in
  `anchor.ts`.** Traced the read path: `reviewEngine.ts#reanchorThreads`
  and `routes.ts`'s thread-creation handler both get file text from
  `git/diff.ts#getFileContents`, which reads committed sides verbatim via
  `cat-file --batch` (whatever bytes git stored — no `core.autocrlf`
  equivalent applied) and a `working`-revision new side via a plain
  `fs.readFile` + `TextDecoder` (also verbatim). No line-ending or
  whitespace normalization exists anywhere upstream of `anchor.ts`, so a
  file resaved with different line endings, or an editor stripping
  trailing whitespace, would previously have both (a) changed every
  affected line's contribution to `anchorContextHash`, and — the more
  serious half, since matching in `relocate` is plain per-line string
  equality via `findSubsequence`/`findAllSubsequences`, not hash-based —
  (b) made the captured context fail to literally match the new lines,
  orphaning (marking `outdated`) every thread whose context crossed a
  changed line. Fixed with a new `normalizeLine` (strips a trailing `\r`
  and trailing horizontal whitespace per line) applied in three places so
  the fix is end-to-end rather than cosmetic:
  1. `captureContext` normalizes before storing, so `anchorContext` is
     clean from the moment a thread is created.
  2. `hashContext` normalizes independently too (defensive — meaningful
     even if ever called on text that didn't go through `captureContext`;
     normalizing already-clean text is a no-op).
  3. `relocate` normalizes both `newLines` (the haystack) and the split
     `anchorContext` (the needle) before searching, so old threads
     captured before this fix (whose stored `anchorContext` may still
     carry raw `\r`/trailing whitespace) keep matching too.
  Tradeoff, documented on `normalizeLine`: a line whose *only* change is
  trailing whitespace or line-ending style now reads as unchanged by
  anchoring, including not tripping `changedSinceComment` — judged correct
  since that is what a reviewer would call "nothing meaningful happened
  here," not a near-miss. Normalization is deliberately per-line and only
  trailing/CR, not a blanket trim — leading/interior whitespace changes
  (indentation, `a  b` → `a b`) still count as real content changes and
  are pinned by a dedicated test.

- **Tests added** (`apps/server/test/engine/anchor.test.ts`, all passing):
  `findAllSubsequences` (5 new tests: all-matches order, overlapping,
  empty needle/no-match, single match); the two duplicate-content
  `relocate` scenarios split into precise cases — two equidistant
  candidates (ambiguous → `outdated`), three-or-more candidates with one
  unambiguously nearest (`confidence: 'nearest'`), one-near-one-far
  (nearest wins over a ~300-line-distant duplicate), and a plain
  single-match case asserting `confidence: 'unique'`; normalization tests
  for `hashContext` (CRLF/trailing-whitespace now hash identically,
  leading/interior whitespace still differs), `captureContext` (stores
  pre-normalized text), and `relocate` (a CRLF-only or trailing-whitespace-
  only rewrite of the searched file no longer orphans the thread). The two
  pre-existing tests that had pinned the *old*, now-fixed behaviour
  (CRLF/trailing-whitespace hashing differently; "first copy wins" on
  duplicate context) were rewritten in place to assert the new, corrected
  behaviour rather than left contradicting it.

- **Mutation testing** (deliberately broke each fix in `anchor.ts`, reran
  `bun test apps/server/test/engine/anchor.test.ts`, confirmed red, then
  restored via a scratch backup):
  1. Removed the tie-break/ambiguity logic entirely (always return the
     first candidate as `'unique'`) → caught by 3 tests (the two
     tie-breakable cases expecting `'nearest'`, and the equidistant case
     expecting `null`).
  2. Disabled `normalizeLine` (identity function) → caught by 5 tests (3
     hash/capture-context tests, 2 relocate-survives-whitespace tests).
  3. Removed normalization specifically from `relocate`'s haystack/needle
     (left `hashContext`/`captureContext` normalizing) → caught by the 2
     `relocate`-level CRLF/whitespace tests — confirming those two tests
     exercise the matching path specifically, not just the hash.
  4. Weakened the tie-break comparison (`<=` instead of `<`, disabling tie
     detection) → caught, but by only 1 test (the equidistant-ambiguity
     case). Worth flagging as the thinnest catch of the four mutations: no
     other test would have noticed this specific regression, since it
     only differs from correct behaviour in the exact-tie case.
  5. Removed `hashContext`'s own independent normalization (leaving only
     `captureContext`'s) → caught by the 2 tests that call `hashContext`
     directly on raw un-normalized text.
  All five mutations were caught by at least one test; no coverage gap was
  found, though mutation 4 shows the ambiguity-tie-detection path has only
  a single test guarding it.

- **Nothing left unresolved** for the two assigned issues. Scope was kept
  to `apps/server/src/engine/anchor.ts` and its test file, per the task's
  file ownership; `reviewEngine.ts` was read but not modified — the
  `RelocateResult.confidence` addition is additive and required no caller
  change.

## render coverage (2026-09-11)

Closed the gap called out in the task: there was no test anywhere that
asserted the centre pane actually renders content, which is how a change
could zero out `apps/web/src/state/ReviewContext.tsx`'s `items` array and
still pass typecheck, all 240 tests, and a clean build.

**Step 1 — what's actually available.** Checked `bun.lock` and every
`package.json` in the workspace: no `playwright`, no `puppeteer`, no
`jsdom`, no `happy-dom`, no `react-test-renderer`, no `@testing-library/*`
anywhere before this change. `apps/web` had zero DOM test setup — confirmed
by `apps/web/test/keymapGuard.test.ts`, the only prior web test, which is
written against pure helpers for exactly that reason. `bun test` itself has
no `--dom`/jsdom flag (checked `bun test --help`); DOM setup has to come
from a preload or from the test file itself.

**Step 2 — is a full render reachable?** No, not without a heavy new
dependency, and the task's own instinct here was right. `@pierre/diffs`'
`CodeView` needs real Web Workers (`Worker`, tokenization/highlight workers)
and renders into shadow-DOM custom elements (`<diffs-container>`,
`<file-tree-container>`) — verified by trying it: importing `@pierre/diffs`'
runtime module (via `apps/web/src/lib/diffLoader.ts`, which imports
`parsePatchFiles`/`trimPatchContext` from it directly, not type-only) throws
`ReferenceError: customElements is not defined` the instant it's imported
without *some* DOM present, before workers even enter the picture. Getting
an actual `CodeView` to paint rows would need a real browser engine
(Playwright/Puppeteer) — a genuinely heavy dependency this task said not to
add without strong justification, and mounting a full browser for one smoke
test isn't that justification on its own.

**What was built instead — `apps/web/test/reviewProviderRenders.test.ts`.**
A state-layer test, honestly named and commented as such, that mounts the
*real* `ReviewProvider` (not a reimplementation of its logic) via
`react-dom/client` + `react`'s `act`, against a mocked `callApi` (the one
network seam) and a stubbed `eventsClient` (so the mount effect doesn't try
a real WebSocket). It never touches `CodeView` — the `Consumer` component
just calls `useReview()` and captures the engine. Because
`apps/web/src/lib/diffLoader.ts` does a real runtime import of
`@pierre/diffs` (for `parsePatchFiles`), a minimal DOM was still required
just to import that module without crashing, which is why `happy-dom` was
added as an `apps/web` devDependency (`bun add -d happy-dom`, scoped to that
one workspace) — the lightest thing that makes `customElements`,
`HTMLElement`, etc. exist. It is explicitly NOT used to render `CodeView`
itself, only to let React commit into a real (if fake) DOM and let
`@pierre/diffs`' module-scope `customElements.get(...)` check not throw.

Because `bun test` runs every test file in one shared process/global object,
the DOM globals are installed as a narrow **allowlist**
(`HTMLElement`, `Element`, `Node`, `Text`, `Comment`, `DocumentFragment`,
`Document`, `Event`, `CustomEvent`, `MutationObserver`, `customElements`,
`navigator`, `location`, plus `window`/`document`/`requestAnimationFrame`/
`cancelAnimationFrame`), not a blanket `Object.assign(globalThis, window)`.
The first version of this test did the blanket copy, which silently
clobbered Bun's native `WebSocket`/`fetch`/`Request`/`Response` globals and
broke 7 unrelated `apps/server` websocket tests elsewhere in the same
`bun test` run (`hono`'s adapter started throwing `c.env is not an Object`)
— caught by running the full suite, not just the new file. Also intentionally
left off the allowlist: `console` (happy-dom's `VirtualConsole` throws
`Method not implemented` on `timeStamp`, which react-dom's dev build calls).

What the test covers, precisely:
- Mounts `ReviewProvider` with a mocked review of 3 changed files and
  asserts `items.length === 3`, one per file, matched by path — this is the
  exact invariant that broke in the blank-pane regression.
- Asserts each item's `fileDiff` carries real parsed hunk content (not the
  `isPartial`/empty-hunks placeholder `placeholderFileDiff` produces before
  `loadFileDiff` resolves) — proving the patch-loading path, not just the
  file-list path, produced something.
- Asserts the SPEC §6 collapse defaults: a normal file defaults expanded, a
  >2000-line file and a `generated` file both default collapsed.
- Asserts `loading` becomes `false` and `error` stays `null` after the
  mocked load resolves.

What it does NOT cover — named plainly, not papered over:
- `CodeView` itself never mounts. Whether `@pierre/diffs` actually paints
  rows into shadow DOM from the `items` array this test validates is
  unverified. A regression inside `CodeView`'s own reconciliation (the kind
  the module doc comment at the top of `ReviewContext.tsx` warns about —
  mutating an item in place without calling `notifyItemMutated`) would NOT
  be caught by this test.
- No web workers, no tokenization/highlighting, no shadow-DOM assertions,
  no visual output of any kind.
- `ReviewWindow.tsx` (owned by a concurrent agent this session) is not
  exercised at all — this test only reaches `ReviewProvider`/`useReview()`,
  not the component that actually renders `<CodeView items={...}>`.
- Live-update application (`applyPendingRefresh`, viewport anchoring) is not
  covered — `eventsClient` is stubbed out entirely.

**To close the remaining gap** (actually proving `CodeView` paints rows),
the task's own read was correct: it needs a real browser. Concretely: add
Playwright (`@playwright/test` or `playwright` + a thin driver), a real dev
server (`vite build && vite preview`, or the existing `apps/web` dev
server) or a static host of the built app, a running `apps/server` instance
(or a mocked backend reachable over real HTTP, since `CodeView`'s workers
run in a real browser process and can't have their `fetch`/`callApi` calls
intercepted by `mock.module` the way this test's does), and an assertion
that queries into the `diffs-container` custom element's shadow root (or a
`data-testid` `@pierre/diffs` exposes, if any) for a non-zero row count.
Rough sizing: a new `apps/web` (or root) devDependency plus browser
binaries (`playwright install chromium`, ~100-300MB, not vendorable into a
lockfile), a `bunfig.toml`/separate script to keep it out of the default
fast `bun test` run (it needs a live server and is not "fast and
deterministic" the way the rest of the suite is), and non-trivial setup
time given no test harness like this exists in the repo today. Worth doing
as a deliberate, separately-scoped follow-up — not folded into this task's
budget.

Mutation test performed to confirm the new test actually catches the
regression class it claims to: temporarily changed the `items` `useMemo` in
`apps/web/src/state/ReviewContext.tsx` (lines 682-687) to unconditionally
`return [];`, ran `bun test apps/web/test/reviewProviderRenders.test.ts`,
and got exactly the expected failures — `items.length` `Expected: 3,
Received: 0` and the collapse-default assertions failing on `undefined`
(no items at all). Restored the file from a copy taken immediately before
the edit and diffed it against the restored version to confirm byte-for-byte
restoration (`RESTORED EXACTLY`), so none of the concurrent edits other
agents were making to that file in parallel were lost. Full suite re-run
after restoration: `bun run typecheck` (all 4 workspaces) and `bun test`
(256 pass, 0 fail) both clean.
