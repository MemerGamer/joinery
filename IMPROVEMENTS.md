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
