# joinery — spec

A local-first, agent-native code review app. Fast diff rendering (Pierre), a
generated reading order that walks you through a change, and comment threads
that Claude Code can answer asynchronously.

Status: agreed scope, not yet implemented.

---

## 1. Product shape

Two surfaces.

**Homebase** — a Linear-like dashboard, one row per **branch** across your
registered repos: branches checked out locally (yours and your agents'), plus
open PRs. Each row shows what's waiting on you — no reading order yet, unviewed
files, unresolved threads, agent runs in flight — and whether the branch has
uncommitted work, a PR, or both.

Homebase rows are **computed lazily, not by running an engine per branch**: one
`git for-each-ref` per repo plus one `git status` per already-attached worktree,
cached and refreshed on window focus. Branches without an open review have no
watcher and no state. Otherwise a dozen repos would mean dozens of live engines
for rows you glance at once a day.

**Review window** — three panes.

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│ file tree    │ CodeView (diffs)              │ reading order    │
│ (changed     │  step header card             │  step 1 ▸        │
│  files only, │  file diff          ✓ viewed  │  step 2 ▾        │
│  static)     │  file diff                    │   · file a       │
│              │  ...                          │   · file b       │
│              │  inline comment threads       │  step 3 ▸        │
│              │                               │ ── threads ──────│
│              │                               │ (overlays right) │
└──────────────┴───────────────────────────────┴──────────────────┘
```

The **threads panel** slides over the reading-order pane; it is an index and
jump-to surface. Threads themselves render inline in the diff.

A **revision picker** in the header switches between the branch's working tree,
its committed head, and its PR head (§4) without leaving the review.

---

## 2. Decisions (settled)

| Question | Decision |
|---|---|
| Review identity | **One review per (repo, branch).** Not per-PR, not per-directory. A PR is metadata that attaches later. |
| Agent powers | **Reply only.** Read-only tools. Agents never edit the code under review. |
| Comments | **Local only.** SQLite is the sole system of record. Nothing is ever posted to GitHub. |
| Code intelligence | **Deferred.** No LSP, no SCIP, no token hooks, no `useTokenTransformer`. |
| Reading order | **Agent-generated, read-only.** Regenerate to change it. No step-level progress tracking. |
| File tree | **Static, changed files only.** Never reordered by the reading order. |
| Homebase auth | Registered local clones; read-only GitHub API via `gh auth token`. |
| Agent interface | **CLI + HTTP API + a shipped `SKILL.md`.** No MCP server. |
| Concurrency | **Unlimited.** No queue, no cap. |
| Shell | **Browser only.** Local server + localhost web app. No Electron, no Tauri. |
| Platform | **macOS for the MVP.** Windows and Linux are §14 — findings recorded, work deferred. |
| UI kit | **shadcn/ui on Base UI + Tailwind v4.** Linear-like, accessible by default. |
| Progress | **Per-file "viewed" checks**, GitHub-style, auto-reset on content change. |
| Code on disk | **Only when a live tree exists.** Attach if the branch is checked out; otherwise render from the object store. A worktree is created only as an agent run's `cwd`. |
| Engine state | **The sorted file list is the state.** No snapshot hash, no delta protocol, no cache invalidation. |
| Icons | **`lucide-react`, exclusively.** |
| Code host | **One `Forge` seam** (`apps/server/src/git/forge/`). Everything host-specific (open and searched pulls, one pull's detail and CI, the pull head refspec, the login, review requests) sits behind it; `forgeFor(repo)` picks the implementation from the origin's host (stored as `repo.remoteHost`). GitHub (`gh`, `github.com`) and GitLab (`glab`, `gitlab.com` or any host containing "gitlab"; head ref `refs/merge-requests/N/head`) are implemented; any other remote gets a forge that reports unavailable. GitLab uses `glab api projects/:fullpath/merge_requests…` and degrades: no line counts, and CI only where GitLab includes `head_pipeline`. Self-hosted hosts need `glab auth login --hostname`. Nothing outside the module calls `gh`/`glab` or hard-codes `refs/pull/`. |

### Consequences worth remembering

**What "never posting to GitHub" actually buys us.** GitHub's inline review
comments must attach to `(commit_id, path, side: LEFT|RIGHT, line, start_line)`
where the line is *inside the PR's diff*. Four things follow from never touching
that API:

1. **We can comment anywhere.** Any line of any file, including fully unchanged
   files and context you reveal by expanding a hunk. GitHub can only accept
   comments on diff-visible lines without the `position`/`diff_hunk` dance.
2. **We own "outdated."** GitHub hides comments on force-push with no way to
   re-anchor. We re-anchor ourselves, so a thread survives a rebase or amend.
3. **Comments can exist on uncommitted work.** There is no `commit_id` to supply.
   GitHub structurally cannot represent this, and it is the entire point of the
   local flow.
4. **No reconciliation.** No polling for edits/deletes, no dedupe against
   GitHub's threads, no ID mapping.

The cost is that your review is invisible to teammates. `joinery threads --markdown`
(§10) is the mitigation.

**Read-only agents keep the *code* still, not the UI.** Agents cannot edit the
files under review, so the diff you are reading never shifts beneath you and
anchors never re-map mid-thread. Replies are still fully **real-time**: each run
reports tool-call activity as it works, and many run at once. The
immutability claim is about the code, not the conversation.

**Code intel deferred is also the fast path** — token metadata inflates DOM size
per token and the worker pool cannot offset that.

---

## 3. Architecture

Everything expensive is server-side: git, worktrees, Claude Agent SDK
subprocesses, SQLite. The UI is a web app over HTTP + WebSocket.

```
apps/server    Bun + Hono + bun:sqlite
               git & worktree management, diff pipeline,
               Agent SDK session manager, event bus (WS)

apps/web       Vite + React 19 + Tailwind v4
               shadcn/ui on Base UI  (accessible primitives, copy-in source)
               @pierre/diffs 1.4.1  (+ /react, /worker)
               @pierre/trees 1.0.0-beta.6
               cmdk, tinykeys, react-markdown + remark-gfm

apps/cli       Bun single-file binary `joinery`
               thin client over the HTTP API, --json everywhere
               ships SKILL.md

packages/core  zod schemas shared by all three
```

Pin both Pierre packages to exact versions: `@pierre/trees` is beta and the
`@pierre/diffs` worker pool is flagged experimental, with daily commits.

### UI kit and accessibility

**shadcn/ui on Base UI.** As of July 2026 shadcn defaults to Base UI — built by
the same engineers who built Radix — and it is copy-in source rather than a
runtime dependency, so it is both the "ready-made components" option and the
lightweight one. Tailwind v4 for tokens. Linear's feel comes from the token set
(tight spacing scale, low-contrast chrome, one accent, fast short transitions),
not from a component library, so that is ours to build on top.

**Icons: `lucide-react`, everywhere, exclusively.** One icon family across the
whole app — file tree status, gutter affordances, thread states, run states,
palette rows, toolbar. No mixed sets, no inline one-off SVGs, no emoji as UI.
Default `size={16}` `strokeWidth={1.5}` to match Linear's weight; icons inherit
`currentColor` so they theme for free. Tree-shaken per-icon imports keep it off
the critical path. Every icon-only control carries an `aria-label` — an icon is
never the only signal for state (pair with text, position, or shape).

Accessibility is a first-class requirement, not a pass at the end:

- Base UI primitives ship correct focus management, roles, and dismiss behavior.
- `@pierre/trees` has built-in keyboard navigation and ARIA to WCAG 2.1.
- Pierre ships colorblind-safe theme variants — `pierre-{dark,light}-protanopia-deuteranopia`
  and `-tritanopia` — exposed in the theme picker, not buried.
- Diff gutter buttons and annotation slots get real labels and visible focus rings.
- Every action reachable by mouse is reachable by keyboard (§11) and through `Cmd+K`.
- Honor `prefers-reduced-motion` and `prefers-contrast`.
- Comment threads are `<article>`-level landmarks so a screen reader can walk them.

### Data directory

All state lives in a **`data/` folder inside the app**, never in user dot-folders.
Override with `JOINERY_DATA_DIR`.

```
data/
  state.sqlite                              reviews, threads, comments, runs, events
  token                                     bearer token, mode 0600
  worktrees/<repo>/<sha>-<branch>/          agent-run worktrees (lazy, cache)
  logs/
  cache/
```

`data/` is gitignored from the first commit. Nested git repos inside it are fine —
git does not traverse ignored directories — but never `git add -f` it.

Server listens on `127.0.0.1:7317`. A bearer token is written to
`data/token` (mode 0600); the CLI reads it from there, the web app gets it at
page load. Nothing binds to a public interface.

---

## 4. Review identity: one review per branch

**A review is `(repo, branch)`.** Not a PR, not a directory. This is the answer
to "will I end up with two review sessions for the same work" — no. The branch is
the spine; everything else attaches to it.

**Detached and unnamed work.** Agent harnesses often commit on a detached HEAD or
an auto-named throwaway. A review may therefore start as `(repo, sha)` and
**adopt a branch later** — the first time a named branch points at a commit in
its history, the review upgrades in place, keeping every thread and viewed check.
`review.branch` is nullable; `review.pinned_sha` carries the identity until then.
A `(repo, sha)` review has no `working` revision, because a detached tree that
nobody named is not something we can follow.

### Where the code comes from — attach, or read the object store

**Reviewing does not require a checkout.** A commit renders entirely from git's
object store: `git diff base...sha` for the file list and patches,
`git cat-file --batch` for hydration and expand-context, `git grep <sha>` for
search. The only thing a checkout buys is a *live, dirty* tree.

So, on review open:

- **Branch is checked out somewhere** — your main clone, or the worktree an agent
  is working in — **attach to that directory in place.** No copy, no snapshot, no
  commit required. This is what makes the `working` revision possible.
- **Branch is not on disk** (a teammate's PR, a fork, a branch you only fetched)
  — **render from the object store.** Fetch the ref, pin it with
  `refs/review/<id>`, create nothing on disk. The picker simply has no `working`
  entry.

We never create a worktree to *look at* code. The one thing that genuinely needs
files on disk is an agent run, because Claude's `Read`, `Grep`, and `Glob`
operate on paths — so a detached worktree is created lazily as **that run's
`cwd`**, and it is an agent-run cache, not review state. Reviews with an attached
root never need one at all.

This is a deliberate reversal of an earlier design that materialized a worktree
per non-attached review. Its load-bearing argument was that code intelligence
cannot resolve against a snapshot — true, but code intelligence is deferred
(§2), so it was paying complexity for a feature that does not exist. When P5
lands, an LSP root is the same shape as an agent `cwd` and reuses the same
lazily-created worktree. Cost of the reversal: about two seconds, once, before
an agent's first run on a PR you have not checked out.

### Local vs remote divergence

The revision picker *is* the local/remote selector, but a selector alone is not
enough when a coworker pushes to the same PR. Compute state on every refresh:

```
git rev-list --left-right --count <head>...<pr>     →  "1  1"   ahead / behind
```

| State | Meaning | Treatment |
|---|---|---|
| `0 0` | identical | nothing shown |
| `N 0` | you are ahead (unpushed work) | quiet badge |
| `0 N` | **remote ahead — you are reviewing stale code** | loud banner, cannot be missed |
| `N M` | **diverged** | loud banner; offer the comparison views below |

`0 N` is the worst failure mode of a local-first reviewer: commenting on code
that has already been rewritten. It never degrades to a subtle indicator.

**Fetching.** We cannot detect any of this without fetching, so
`git fetch origin refs/pull/<N>/head` runs on window focus and on an interval.
It is read-only — it moves a ref, never touches the working tree, and never
pulls, merges, or rebases. Nothing happens to your tree unless you ask for it.

**Comparisons are 3-dot, always.** Verified:

```
git diff <head>...<pr>   →  their change only                ✅
git diff <head>..<pr>    →  also renders YOUR commits as deletions   ❌
```

Two-dot is wrong in precisely the diverged case it would be reached for.

**Changes since you last looked** *(not built yet)*. Planned as a commit/SHA
range picker, as on GitHub's "Files changed" tab: beyond the three revisions,
pick any commit or range of commits on the branch and view just that slice —
`<from-sha> → <to-sha>` — instead of the whole PR. "Since you last looked" is
then one preset of that picker: the PR head SHA last rendered (persisted as
`last_seen_pr_sha`, currently unused) to the current head, showing only what
the coworker pushed. Threads on lines they touched get the "changed since you
commented" badge (§4, *Following a live worktree*).

**Default revision does not silently flip.** When attached, `working` stays the
default even if the remote is ahead — it is your reality, and switching you into
someone else's revision without asking is its own failure. The banner does the
telling.

### Root resolution: the decision procedure

Not a judgment call. On review open and on every refresh, to render revision `R`:

```
1. R is `working`?  (needs a live dirty tree)
   ├─ branch checked out in some worktree?  → ATTACH there, create nothing
   └─ not checked out anywhere?             → `working` does not exist:
                                              hide it from the picker,
                                              fall back to head/pr
2. R is a commit (`head`/`pr`) at SHA S?
                                            → READ THE OBJECT STORE.
                                              Never a checkout, never a copy.
```

One question: *is there a live tree to follow, or not.* Rendering a commit is
never a placement decision, because it never touches the filesystem.

A checkout is decided separately, and only for agent runs:

```
agent run on a review with an attached root  → run there, `cwd` = attached path
agent run with no attached root              → detached worktree at the pinned
                                               SHA under data/worktrees/,
                                               reused by later runs, swept on
                                               review close
```

### Worktrees in arbitrary locations

**Location never matters.** Git's worktree registry is central, not positional:
every linked worktree is recorded in `$GIT_COMMON_DIR/worktrees/<name>/gitdir`
as an absolute path. `git worktree list --porcelain`, run from *any* worktree of
the repo, returns all of them wherever they live. Verified:

```
worktree created at /tmp/wtloc/elsewhere/deep/nested/wt1  → listed from the main repo
worktree created FROM INSIDE that one, at another path    → listed from the main repo
list run from a linked worktree                           → identical output
```

So we never scan the filesystem and never guess conventional paths. One
`git worktree list --porcelain` in the registered repo root is the complete,
authoritative answer — including worktrees an agent made somewhere unusual. It
also doesn't matter whether the path you registered is the main repo or a linked
worktree; both see the same registry.

Three real edges, all verified:

**1. Reported paths are realpaths.** Git resolves symlinks and reports the
canonical path — on macOS a worktree at `/tmp/x` lists as `/private/tmp/x`, and
`git rev-parse --show-toplevel` from inside a symlinked path returns the target,
not the link. Every path comparison in the engine — attach lookup, dedupe,
refcounting, "is this the root I'm watching" — normalizes through realpath
first. (Windows has its own variants of this; §14.)

**2. A worktree moved with plain `mv` goes stale but still holds its branch.**
The registry keeps pointing at the old path, `git worktree list` marks it
`prunable`, and a checkout is refused against a directory that no longer exists:

```
fatal: 'feat/y' is already checked out at '/private/tmp/.../wt2'   (exit 128)
```

The fix is `git worktree repair`, run *from the new location* — which only the
user knows. And `git worktree prune` is emphatically not a substitute:

```
mv wt → wt-moved ; git worktree prune ; git -C wt-moved status
  → fatal: not a git repository: <repo>/.git/worktrees/wt
  → repair can no longer recover it either
```

**Pruning a moved worktree destroys it.** `prune` is also global — there is no
`git worktree prune <path>` — so a single call could take out a user worktree we
know nothing about, along with any uncommitted work in it. Hence the rule:

> **The engine never prunes, moves, repairs, or removes a worktree it did not
> create.** Cleanup of our own is scoped: `rm -rf` the directory under
> `data/worktrees`, then delete exactly `$GIT_COMMON_DIR/worktrees/<our-name>`.

Verified that this leaves a co-resident stale *user* worktree fully repairable.
When a foreign stale entry blocks us, we don't touch it: we materialize a
detached worktree at the SHA instead (which always works — the block is on the
branch name, not the commit) and surface a one-line note with the exact
`git worktree repair` command to run if they want the old one back.

**3. A separate clone is genuinely invisible.** If the branch is checked out in a
different *clone* of the same remote, no registry knows about it — separate
object store, separate worktree list, and finding it would mean scanning the
disk, which we won't do. Consequence: we materialize from the registered clone
instead. The review is correct, just not attached, so `working` won't show that
other clone's uncommitted edits. The fix is one action by the user: register that
clone as a repo too, at which point it's the same case as everything above.

### Agent worktrees are a cache, not state

The only worktrees we create are agent-run `cwd`s. Verified against git:

```
rm -rf <worktree dir>       git marks it "prunable", nothing corrupted
rm -rf $COMMON/worktrees/N  scoped cleanup of exactly our entry
re-add from (repo, sha)     byte-identical rebuild
two worktrees, same SHA     ALLOWED by git — dedupe is ours to implement
git worktree add --detach   ~1.9 s on a 20k-file repo
```

Note the second line. **We never run bare `git worktree prune`** — see
*Worktrees in arbitrary locations*, above. Cleanup is always scoped to the
registry entries we created.

Therefore:

- **Identity is `(repo, SHA)`**, deduped by us. Directory named
  `data/worktrees/<repo>/<sha-short>-<branch-slug>`; the branch is legibility
  only, the SHA is the key.
- **No user data lives there.** Threads, reading order, and viewed state are in
  SQLite keyed by `(review, path, blob-sha)`, never by directory path.
- **Deletion is always safe.** `rm -rf data/worktrees`, plus scoped removal of
  our own registry entries, costs at most one rebuild before the next agent run.
- Swept by age: any worktree unused for 7 days is removed (directory plus its
  own registry entry) at startup and then hourly for as long as the server runs
  (`agent/maintenance.ts`).
- Keep `refs/review/<review-id>` at each reviewed SHA so the commit survives GC.
  **This ref is what makes a directory optional** — it is why rendering can live
  entirely in the object store, and it matters more under this design, not less.

**Expected volume:** zero, until you ask an agent to reply on a PR that is not
checked out locally. Reading, by itself, never creates a directory.

### Why we do not materialize for rendering

A worktree is a checkout of a **commit**, so it cannot represent uncommitted work
in the first place. Verified:

```
git stash create          snapshot commit, working tree intact
worktree from it          tracked.txt      present
                          untracked.txt    MISSING
                          build/out.js     MISSING  (git-ignored)
```

So "always materialize" was never available for the `working` revision — the one
case where a live directory is genuinely required. And for the other direction,
a commit needs no directory at all: `diff`, `cat-file --batch`, and `grep` all
take a SHA. Materializing to render would have been paying ~1.9 s and a
lifecycle to obtain something `cat-file` returns in 92 ms per 400 blobs.

The split is therefore **live vs. frozen**, exactly where git itself splits:

| Reviewing | Root | Why |
|---|---|---|
| uncommitted work | attach, read in place | only faithful option |
| a commit (PR, branch you are not editing) | none — object store | nothing on disk can go stale |

One `resolveRoot()`, one question, no `isLive` flag.

**When an attached root goes away.** If a directory stops holding the reviewed
branch — you `git checkout main` in your clone — there is nothing to freeze and
nothing to offer. `working` leaves the picker, `head` keeps rendering from
`refs/review/<id>`, and a banner says why. Check the branch back out and
`working` returns.

### Invariant: a review never holds a branch

Worktrees we create are **always** `git worktree add --detach <sha>`. Verified
against git: the "already checked out" rule applies to *named branches* only, so a
detached worktree collides with nothing, and multiple detached worktrees at the
same commit are fine.

```
review worktree DETACHED at PR head → agent checks out feat/x   ALLOWED
any worktree HOLDS feat/x           → anything else checks out  BLOCKED
                                      fatal: 'feat/x' is already
                                      checked out at '...'
```

Consequence: **nothing the review app does can ever block you or an agent from
checking out a branch.** We never "promote" a review worktree onto the branch it
is reviewing — that is precisely what would cause the collision.

### Taking over someone else's PR

The flow this invariant exists for:

1. A colleague's PR arrives. The branch is not on disk. We fetch it, pin it with
   `refs/review/<id>`, and render from the object store. We create nothing and
   hold no branch.
2. You take over. Your agent — or its harness, which may create its own worktree —
   checks out the real branch wherever it likes. Not blocked, because there is
   nothing to be blocked by.
3. We see the branch appear in `git worktree list --porcelain` and **attach the
   review to that directory**. Same review, same threads, same reading order;
   `working` appears in the picker for the first time.
4. `working` now live-follows the agent's edits, while `pr` still shows what the
   colleague pushed — same merge-base, so the picker becomes a genuine
   "theirs vs mine" toggle. After your agent pushes, we refetch and `pr` moves;
   threads re-anchor (§8).

Supporting details:

- Keep a local ref `refs/review/pr/<N>` for the fetched head so the SHA is not
  garbage-collected and can be updated on refetch.
- **Fork PRs** are pushable only with "allow edits by maintainers" and a remote
  pointing at the fork. A git/GitHub constraint — we detect it and say so plainly
  rather than failing obscurely.
- Remove any agent-run worktree on review close, and sweep our own stale registry
  entries on startup so abandoned reviews do not accumulate.
- **Open edge case:** if the harness branches to a *different* name
  (`feat/x-2` off `origin/feat/x`) instead of checking out `feat/x`, that is a
  different branch and therefore a different review. Offer an explicit "carry
  threads over from `feat/x`" prompt, matched on base SHA.

### Revisions within one review

A review does not have "a" state; it has a revision picker.

| Revision | Contents | Available when |
|---|---|---|
| `working` *(default)* | live on-disk state: committed + staged + unstaged + untracked | branch is attached in place |
| `head` | the branch's committed tip | always |
| `pr` | `refs/pull/<N>/head` | a PR exists (may differ from `head` if unpushed) |

Each diffs against `merge-base(<default-branch>, <revision>)`. Those bases
coincide **only while the revisions share history** — if the PR is rebased
remotely, `base(main, pr)` moves and `base(main, head)` does not, and the two
revisions are no longer directly comparable. Detect it and say so; never render
across mismatched bases silently.

Switching revision re-anchors threads (§8); the reading order and file-viewed
state carry across.

### Following a live worktree

Once attached — whether to your clone or an agent's worktree — the review follows
that directory. Both committed and uncommitted work appear, and they render
identically, because `working` diffs from the **merge-base**, not from `HEAD`:

```
git diff <merge-base>          base → working tree   committed + staged + unstaged
git diff <merge-base>..HEAD    base → committed tip  committed only
```

So when an agent commits, nothing in the view moves; the content was already
there. **Untracked files are invisible to `git diff` entirely** and must be
listed with `git ls-files --others --exclude-standard` and synthesized as
add-diffs, or new files an agent creates silently never appear.

Detection and refresh:

Two recursive watches and a `status` call — the full mechanism is §5. Nothing
here needs cache invalidation: `cacheKey` is the blob SHA, so new content is a
new key by construction.

Three cases that need explicit handling rather than a silent re-render:

| Change | Effect | Handling |
|---|---|---|
| Files added/removed | Reading order is stale — new files belong to no step | Collect into an "added since reading order" bucket; offer regenerate |
| Rebase | Merge-base moves, so the *entire* diff changes | Full invalidation behind an explicit banner |
| Agent rewrites commented lines | Threads re-anchor or go `outdated` | Also badge the thread **"changed since you commented"** |

**Refresh is staged, never automatic in place.** Show an "N files updated ·
Refresh" pill; apply on click or when the affected file scrolls out of view.
Never mutate content under the cursor.

**Scope note on read-only agents.** "Agents never edit the code under review"
(§2) covers *review-reply* agents. A **take-over** agent edits the branch under
review by definition, so that guarantee does not hold in that flow — the staged
refresh above is what keeps it from feeling the same way.

### Your four questions, answered directly

- **Agent codes on a local branch in a separate chat — separate worktree?**
  No. That branch is already checked out in the agent's worktree, so the review
  attaches to that directory. One review, one branch.
- **I edit my local branch — does the reviewed copy update?**
  There is no copy. It reads in place. A watch fires, `git status` runs, the file
  list changes, and only the changed items get a `version` bump — so only changed
  files re-render.
- **We open a PR later — two sessions?**
  No. The PR number attaches to the existing `(repo, branch)` review and adds the
  `pr` revision to the picker. Threads, reading order, and viewed state are
  untouched.
- **Uncommitted changes?**
  That is the default `working` revision. Unstaged and untracked included.

### Schema

```
repo    (id, root_path, remote_owner, remote_name, default_branch)
review  (id, repo_id, branch?, pinned_sha?, base_ref, pr_number?,
         attached_path?, current_revision, created_at)
agent_worktree (repo_id, sha, path, created_at, last_used_at)
```

`branch` is null for a detached `(repo, sha)` review until it adopts one;
`pinned_sha` is null once it has. `attached_path` is set only while the branch is
checked out somewhere — there is no second path column, because rendering a
commit never uses a directory. `agent_worktree` is a cache table keyed by
`(repo, sha)`, not review state; deleting every row costs one rebuild.

---

## 5. The branch state engine

Everything in §4 describes *where* the code comes from. This section describes
how it stays correct while git moves underneath us — you editing, an agent
committing, a coworker pushing, someone rebasing — without the viewer ever
flickering, jumping, or losing a thread.

### The two mutable layers

A review has one immutable fact — `(repo_id, branch)` — and two derived layers
that the engine owns:

1. **Root binding.** Which directory on disk backs the current revision.
   Re-derived by the §4 decision procedure. Cheap; changes rarely.
2. **The file list.** What to actually render — and the state itself.

```
FileList = sorted [ { path, status, old_blob, new_blob } ]
  plus base_sha, head_sha
```

**The list is the key.** There is no digest and no hash over it: to detect
change you compare the new list against the old one, and the set difference *is*
the delta. Nothing else needs computing.

This replaces an earlier design that hashed `(path, mode, size, mtime)` into a
`dirty_digest`. That was wrong twice. It put mtime in the identity while also
claiming an mtime-only touch was a no-op — it cannot be both. And it assumed
`status --porcelain=v2` reports the worktree blob hash. It does not; verified:

```
1 .M N... 100644 100644 100644 <hHEAD> <hIndex> a.txt
                               ^^^^^^^ ^^^^^^^^ HEAD and index only
```

The worktree hash is absent, so a second pass is required regardless — and we
already need it anyway, for Pierre's `cacheKey`, for `changed[].new_blob`, and
for `file_viewed`. One `git hash-object` spawn over all dirty paths is ~84 ms at
60 files. Computing it once and comparing lists is strictly less work than
computing it *and* digesting it.

### Detectors — how we notice

Two recursive watches and one poll. **Event payloads are ignored** — every
signal means exactly one thing: *run a tick*.

| Detector | Watches | Catches |
|---|---|---|
| Root watch | the attached directory, recursive | you typing, an agent writing files |
| Git watch | `$GIT_COMMON_DIR`, recursive | commit, checkout, rebase, reset, merge, branch create/delete, fetch, `git add`, **and `worktrees/<name>/{HEAD,index}` for free** |
| Remote poll | one loop per repo (`repoPoller.ts`), not per review: one `git fetch origin` for the whole repo plus every review's PR ref, and one forge call for the repo's open pulls — every 15 s while anything in the repo is watched, every 3 min otherwise, skipped while a git command holds the index lock | a coworker pushing; the base advancing; the PR retargeted, merged, or its CI moving |

The two collapse into one when the attached root is the main clone. An earlier
draft enumerated specific metadata paths and made a point of the per-worktree
`HEAD`/`index` being private while `refs/` is shared — a real distinction, but
one that only mattered *because* the paths were enumerated. A recursive watch on
`$GIT_COMMON_DIR` already contains `worktrees/<name>/`, so the subtlety
disappears rather than being handled.

Cost of ignoring payloads: a 20k-file checkout emits thousands of events into a
150 ms debounce. FSEvents coalesces these — measured, 51 events across five git
operations — so on macOS this is a non-issue. (It is not free on Linux; §14.)

Fetching the default branch in the same poll is not optional. The base is
`merge-base(origin/<default>, rev)`, and `origin/<default>` never moves unless
something fetches it — so without this, "the base moved" can never fire and the
diff silently drifts as main advances underneath the review.

Which root we watch comes from `git worktree list --porcelain`, re-read on every
tick — 30 ms, cheaper than deciding when to re-read it. So a worktree an agent
creates at an arbitrary path starts being watched on the next tick, and one that
disappears stops. No path conventions, no filesystem scanning (§4, *Worktrees in
arbitrary locations*).

The remote poll is the only network path in the engine, and it can never change
what you are looking at — see *Never auto-switch*, below.

### Stored state — one rule, one writer

A review's base and head are decided in exactly one place
(`engine/reviewState.ts`): head is the first rung of the ladder that resolves
(attached worktree, local branch, remote-tracking branch, the PR's fetched head,
the pinned sha, the review's own pin); base is `merge-base(origin/<baseRef>,
head)`, where `baseRef` is the PR's target branch as the forge currently
reports it (the poller moves it when a PR is retargeted), else the repo's
default branch. When head is already inside the base — merged, often with the
branch kept — the base before the merge is used: the one the forge reported
for the merge commit (asked once), else the last non-empty base pinned at
`refs/review/base/<id>`.

The result (base, head, diff size, blobs, the PR and its CI) is stored in
`review_state`, and the repo's open pulls in `repo_state`. Both the repo
poller and a review's live worker write through that same function; Homebase
and the API only read it. Every change bumps a version and publishes
`topic.changed` after the write commits (see *Transport*).

### The tick

Events coalesce into one debounced tick per review (150 ms trailing, 1 s
ceiling). A tick is:

1. Re-run root resolution. If the root moved or vanished, rebind.
2. `git status --porcelain=v2 --branch -z --untracked-files=all`. The `--branch`
   header carries `# branch.oid`, so this is also the `rev-parse` — one spawn,
   ~67 ms on a 20k-file repo. `merge-base` reruns only when `head_sha` or the
   base ref moved.
3. `git hash-object` over the dirty paths, one spawn, to complete the list.
4. **List identical → stop.** The overwhelmingly common case: a save that changed
   no bytes, another tool running `git status`, an mtime touch. One or two
   subprocesses, zero UI work.
5. Otherwise set-diff old against new and push the difference.

**All three revisions are kept warm, not just the one currently selected.**
The engine caches one `FileList` per revision (`working`/`head`/`pr`) and each
detector only rebuilds the revision(s) it can actually invalidate: the root
watch only `working`, the git watch only `head`, the PR-ref half of the remote
poll only `pr`. The default-branch half of the remote poll rebuilds all three,
since `merge-base(baseRef, ...)` is shared across them. A revision switch
(`POST /revision`) is therefore a cache read — no tick, no git spawn — rather
than a recompute triggered by the click.

Because each connection can watch a different revision (see *Transport*,
below), thread re-anchoring below still only runs against the review's
persisted revision, to avoid two revisions racing to mutate the same thread
row; other revisions project a thread's position at render time instead of
writing it back (see *Threads across snapshots*).

### The delta — the contract with the UI

There is no delta protocol and no snapshot handshake. The server sends the
current file list; the client set-diffs it against the one it holds. Reconnect
is "send me the list." A tuple `(path, old_blob, new_blob)` is all the identity
either side needs, and the diff is ~30 lines:

- `added` → splice a new item in at its sorted position
- `removed` → splice out
- `changed` → **mutate that item's `fileDiff` in place and bump `item.version`**

That last one is the same mechanism Pierre documents for `loadDiffFiles`, and
it's why item identity has to stay stable: the object keeps its reference and
its `id`, so React never unmounts it, the virtualizer never loses its position,
and the worker pool re-highlights exactly one file. Untouched files are never
re-parsed, and because `cacheKey` is the blob SHA, even a re-parsed file usually
hits the highlight LRU.

**Editing one file in a 300-file review re-renders one file** — from a list
compare, with no cache-invalidation logic anywhere. Because `cacheKey` is the
blob SHA, there is nothing to invalidate by construction: new content simply has
a new key. Do not write invalidation code.

### Mid-operation states

During a rebase, merge, cherry-pick, or bisect, `HEAD` is detached and the
branch is momentarily held by nobody — root resolution would otherwise drop
`working` from the picker and restore it seconds later, flapping the UI. So the
engine checks for `$GIT_DIR/{rebase-merge,rebase-apply,MERGE_HEAD,CHERRY_PICK_HEAD,BISECT_LOG}`
and, when any is present, **holds the last good snapshot** and shows a passive
"rebase in progress" chip instead of recomputing. One recompute when it clears.

Conflicted files need no special handling: a file with `<<<<<<<` markers is just
bytes, and `working` renders it as-is. We never parse or interpret conflict
state — resolving is the user's job in their editor, and the moment they save,
it is an ordinary content change.

### Scroll and selection stability

The failure mode of every live-updating diff viewer is the scroll jumping.

- The viewport anchor is stored as `(path, side, line)` of the topmost visible
  line — never a pixel offset. After a delta is applied, the anchor is resolved
  against the new snapshot and restored.
- If the anchored file was removed, fall back to the nearest surviving file in
  reading order.
- The file list is **never re-sorted** on update. Order comes from the static
  changed-files tree, so an added file lands in place and nothing else shifts.

### Threads across snapshots

Threads carry `anchor_blob_sha` and `anchor_context_hash`. On each delta:

- `new_blob == anchor_blob_sha` → exact, no work.
- File changed → search the new blob for the context hash. Hit: update line
  numbers, stay current. Miss: `outdated = true`, keep the thread, render it
  collapsed at its last known position with a badge.
- **A thread is never deleted because the code moved.** GitHub loses them
  because it only owns one side; our comments are local, so we own both.

`file_viewed` is keyed by `(review_id, path, blob_sha)`, so a changed blob
simply fails to match and the check clears itself. There is no invalidation
code.

**Cross-revision projection.** A thread row is re-anchored and written back
only against the review's *persisted* revision — the one `currentRevision`
names — never against whichever revision a given tab happens to be viewing
(see *Revisions within one review* and *Transport*: two tabs can watch
different revisions independently). Writing from two revisions in the same
tick would race the one shared row, and the two revisions can legitimately
disagree on a blob (`working` has an uncommitted edit `head` doesn't, say).

A tab on a non-persisted revision instead gets its thread positions
**projected at read time**: `GET /threads?rev=<revision>` runs the same
`anchorBlobSha` fast-path and `relocate()` context search the persisted path
uses, but returns the result without writing it back — recomputed from the
current blob on every fetch, so there is nothing to invalidate by
construction, same as everywhere else in this section. The persisted row
(`outdated`, `anchorBlobSha`, `startLine`/`endLine`) is unaffected either way.

### Every case, and what the engine does

**This table is a test plan, not a design.** The engine has no branch per row —
almost every one of these is "a tick ran `git status`, and the list either
changed or it didn't." If the implementation ever grows a case statement shaped
like this table, something has gone wrong. Read it as the acceptance checklist.

| What happens | Detector | Root | File list | UI |
|---|---|---|---|---|
| You edit a file | root watch | — | dirty | that one file re-renders |
| You save, no byte change | root watch | — | same | nothing (early out) |
| You `git add` | git watch | — | same | nothing — `working` shows staged and unstaged alike |
| You commit | git watch | — | head moves, dirty shrinks | `working` looks identical; `head` updates |
| Agent edits in the attached worktree | root watch | — | dirty | same as you editing |
| Agent commits in its own worktree, same branch | git watch | — | head moves | `head` updates; `working` follows if we're attached there |
| Agent works on a different branch | — | — | — | invisible — different branch is a different review |
| Agent commits detached, no branch | git watch | — | head moves | a `(repo, sha)` review renders it; adopts the branch if one later appears |
| You switch branches in the attached worktree | git watch | **lost** | — | `working` leaves the picker, fall back to `head`, banner explains |
| You check the branch back out | git watch | **regained** | — | `working` returns, prior revision choice restored |
| Attached worktree directory deleted | root watch | lost | — | as above; if it was ours, scoped registry cleanup |
| A worktree is `mv`'d and now stale | git watch | lost if ours | — | if ours: rebuild on next agent run. If the user's: show the `worktree repair` hint, touch nothing |
| Coworker pushes to the PR | remote poll | — | `pr` moves | a chip on the revision picker: "remote +2" |
| You fetch or pull | git watch | — | `pr` moves | same chip |
| Remote rebase moves the base | remote poll | — | `base_moved` | banner, 3-dot diff recomputed, threads re-anchor |
| You rebase locally | git watch | — | head + base | full recompute; threads relocate by context hash |
| Branch force-pushed remotely | remote poll | — | `pr` moves | chip; the SHA you were reading stays renderable via `refs/review/<id>` |
| Branch deleted locally | git watch | lost | no head | review goes `orphaned`, still readable from its ref pin, comments intact |
| PR opened on an existing review | poll / manual | — | — | `pr_number` fills in, a third revision appears |
| PR merged or closed | poll | — | — | homebase badge; the review stays open until you archive it |
| Agent worktree deleted by you | root watch | — | — | nothing until the next agent run, which rebuilds it |
| Two reviews want the same SHA | — | — | — | nothing on disk to share; only agent worktrees dedupe, by `(repo, sha)` |
| The repo directory moves or disappears | root watch | fatal | — | repo marked unavailable; last-known list stays on screen, read-only |

### Concurrency and safety

- **One engine actor per review.** Ticks are serialized; events arriving mid-tick
  set a dirty flag that schedules exactly one more. No overlapping recomputes.
- **Snapshots are immutable and content-keyed**, so a late result can't clobber a
  newer one — compare keys, drop stale.
- **`GIT_OPTIONAL_LOCKS=0` on every invocation.** A read-only observer must never
  take `index.lock` and never make the user's or an agent's git command wait.
  This has a measured cost: after a mass mtime change (a checkout, a formatter
  run), `status` goes 82 ms → 581 ms and settles around 250 ms, staying elevated
  until some *non-observer* git command refreshes the index — because we
  deliberately cannot write it back. That is the correct trade. Do not "fix" it
  by dropping the flag.
- **Write allowlist.** The engine's only writes anywhere are
  `git worktree add --detach` under `data/worktrees`, scoped deletion of the
  registry entries it created, and
  `update-ref refs/review/*`. It cannot touch the user's branch, index, or
  working tree. Everything else goes through a read-only subcommand allowlist.

### Never auto-

Three things the engine deliberately does not do, because each one steals the
review out from under you:

1. **Never auto-switch revision.** Remote movement lights up a chip. Changing
   what you are reading is always your keystroke.
2. **Never auto-scroll.** Updates restore the anchor; they do not chase new
   content.
3. **Never resolve, delete, or hide a thread.** Outdated threads get a badge and
   stay put.

### Transport

`WS /api/events` is topic-based (Bun's native pub/sub). A client `watch`es the
topics it shows — `home` (anything a Homebase card shows), `repo:<id>` (the
repo's open pulls), `review:<id>` (one review) — and receives only theirs.
`topic.changed` carries just a per-topic version: the client re-reads through
the same API a fresh load uses (TanStack Query invalidation), so a fresh tab
and a live update can't disagree. A review's topic also carries its live
events: `files.changed` (a revision's list), `root.rebound`, `remote.moved`,
`thread.relocated`, `thread.*`, and `run.*`. The browser never polls. The client holds the
current file list; on reconnect it simply asks for the list again and set-diffs
it — there is no handshake and no version negotiation. Locally-initiated actions
(posting a comment, marking viewed) apply optimistically and are reconciled
against the authoritative row.

Watching `review:<id>` keeps the review's live worker running and sends its
current file list and state back at once. The worker publishes every
revision's list to the topic, tagged with its revision, and each tab applies
only the revision it's showing. `root.rebound`'s `state` is one global,
review-wide snapshot (root binding, divergence, available revisions, etc.); its
`currentRevision` field reflects the review's *persisted* choice, not
necessarily what a given tab is looking at — a client that has switched
locally keeps its own choice rather than adopting the broadcast one.
This is what makes two tabs on the same review able to sit on different
revisions independently: nothing server-side is "the" current revision except
the one written by the last `POST /revision`, used only as the default the
next freshly opened tab starts from.

---

## 6. Rendering (Pierre)

One `CodeView` per review — never one `FileDiff` per file. Items are the
reading order's files, in order, as `{id, type:'diff', fileDiff, annotations,
version}`.

- `renderCodeViewHeader` → the current step's title + guidance card
  (non-virtualized, always in the DOM).
- `lineNumber: 0` annotation → per-file note within a step.
- `lineAnnotations` + `renderAnnotation` → inline comment threads. Annotations
  render through slots, so normal React and CSS work despite the shadow DOM.
- `enableGutterUtility` + `onGutterUtilityClick(range)` → the hover `+` button,
  including click-and-drag multi-line ranges. Do not hand-roll this.
- `loadDiffFiles(fileDiff)` → hydrate partial diffs with full file contents when
  a user expands unchanged context (see *Expanding context* below).
- `scrollTo({item|line|range})` → step and thread navigation.
- File tree: `@pierre/trees` `FileTree`, **changed files only**, with git-status
  decorations and `preparePresortedFileTreeInput()`. Static — it is the shape of
  the change and never reorders to follow the reading order. Per-file "viewed"
  state renders as a check in the row.

### Performance checklist (non-negotiable)

1. **`cacheKey` = git blob SHA** on every `FileContents` and diff. Two LRU
   caches (files + diffs), `totalASTLRUCacheSize` 100 each. Revisiting a file
   across steps or panes then costs nothing. Highest-leverage single decision.
2. **Worker pool** via `WorkerPoolContextProvider`, Vite worker factory,
   `worker.format: 'es'` in vite config. `poolSize = hardwareConcurrency - 1`.
   Main thread paints plain text synchronously; workers swap in highlighting.
3. **Theme is pool-owned.** Once a pool exists, `theme`, `lineDiffType`,
   `tokenizeMaxLineLength`, and `useTokenTransformer` come from
   `WorkerPoolManager` and per-component options are *ignored*. The UI light/dark
   toggle and the diff theme are one coordinated, debounced action through
   `useWorkerPool().setRenderOptions()` — which clears the render cache and
   re-renders everything.
4. **Stable identity.** Module scope or `useMemo` for files, diffs, options, and
   render callbacks. `CodeView` reconciles on `id` + a **`version`** counter, not
   deep equality — bump `version` on any content, annotation, or `collapsed`
   change. Never call `parsePatchFiles` during a render.
5. `trimPatchContext()` before sending patches over the wire;
   `preloadHighlighter()` to prime languages for the review's file set.
6. **Token hooks and `useTokenTransformer` stay off** (code intel is deferred).
7. Leave `pointerEventsOnScroll` at its default.
8. No SSR — it's a localhost app.

### Payload and scale

Measured on a synthetic 20k-file repo with a 200-file / 68k-line branch:

```
git status --porcelain=v2 -z -uall     67 ms
git diff --name-status base...HEAD     49 ms
full git diff base patch              110 ms  →  2.5 MB
400 blobs via one cat-file --batch     92 ms
50 blobs, one spawn each              738 ms   ← never do this
git worktree add --detach            1884 ms
```

Two rules follow.

**Never ship the whole patch.** The file list goes first — one round trip, a few
KB. Per-file patches are fetched on demand in viewport and reading-order
sequence, and cached by `(old_blob, new_blob)`, which is immutable so the cache
never expires. This is what makes a full recompute per tick affordable: the
server side is ~250 ms and the wire is ~5 KB.

**Batch every blob read.** One `git cat-file --batch` for all hydration in a
tick, never a spawn per file — 92 ms versus 738 ms is the entire difference
between a responsive expand-context and a janky one.

**Budget.** File list rendered in under 200 ms, first visible file highlighted
in under 500 ms, on a 300-file review. If a change makes either number worse,
it is a regression regardless of how clean it is.

### Large, generated, and binary files

A single 40k-line lockfile dominates parse, highlight, and scroll, and will hurt
before any git edge case does:

- Binary (per `git diff` detection) → stub row, size and mode only, never parsed.
- Over 2,000 lines or 500 KB → collapsed by default, expand is explicit, and it
  is excluded from any "expand all" action.
- `linguist-generated` and `linguist-vendored` from `.gitattributes` → collapsed
  by default and sorted to the bottom of the tree, mirroring GitHub.
- Collapsed files still count for `file_viewed` and can still hold threads.

### Renames

`thread.path` and `file_viewed.path` are path-keyed, so `git diff -M` and
`status` `R` entries would orphan both. The file list therefore carries
`old_path` on rename entries, and a rename rewrites `thread.path` and
`file_viewed.path` in the same transaction that applies the list. A rename with
content changes is a rename plus an ordinary content change; threads re-anchor
by context hash as usual.

**Submodules are ignored.** `status --porcelain=v2` emits `S...` submodule flags
and `u` unmerged entries; both are skipped rather than fed to `hash-object`,
which would choke on a directory.

### Themes — ship all 75

Verified against `@pierre/theming@1.0.1`: the theme registry is a map of dynamic
import thunks, one per theme —

```js
"catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
```

**65 Shiki themes + 10 Pierre themes, every one lazy.** The bundle pays for ~75
arrow functions; Vite code-splits each theme JSON into its own chunk, fetched
only when selected. There is no reason to curate a subset.

Pierre's ten: `pierre-{dark,light}` plus `-soft`, `-vibrant`,
`-protanopia-deuteranopia`, and `-tritanopia` variants. The colorblind-safe pairs
are surfaced directly in the picker.

`registerCustomTheme(name, () => import('./theme.json'))` takes any VS Code theme
JSON, so users can drop in their editor theme.

UI chrome themes (light/dark app shell) are separate CSS-variable sets. Because
the worker pool owns the diff theme, switching is **one coordinated, debounced
action** across both.

### Split vs unified

`diffStyle` is a **viewer-wide** `CodeView` option. `CodeViewItem` is only
`{id, type, file|fileDiff, annotations, collapsed, edit, version}` — there is no
per-item options field, and the docs state "all other options are shared between
all files and diffs."

So: **one global toggle (`u`), split by default.** No per-file override. If
Pierre later ships per-item option overrides we can revisit; dropping to
`Virtualizer` + `VirtualizedFileDiff` to get it sooner is not worth the cost they
document (every top-level container stays mounted, more blanking on fast scroll,
"generally less performant than CodeView").

### Expanding context

GitHub-style "load more code above/below the hunk" is built in and we use it as-is.

- `hunkSeparators: 'line-info'` (the default) renders the collapsed line count
  between hunks **and is clickable to expand**. No custom UI needed.
- Expansion requires the full file, so diffs must be hydratable: patch-derived
  `FileDiffMetadata` is *partial* until `loadDiffFiles(fileDiff)` supplies both
  sides. Ours reads straight off the attached worktree or the object store —
  a local file read, not a network round trip.
- Return `{oldFile, newFile}` with `cacheKey` set to each side's blob SHA, so an
  expanded region reuses the highlight cache instead of re-tokenizing.
- Hydration mutates the `FileDiffMetadata` **in place** (`isPartial` flips to
  `false`) and preserves object identity — so keep the same object across renders
  and bump the item's `version`, or the expansion silently resets.
- `e` expands the hunk at the cursor, `Shift+E` expands the whole file.

**One interaction to respect:** Pierre documents a WebKit/Safari 26 bug where
`hunkSeparators: 'line-info'` combined with a *custom* `renderGutterUtility`
causes scroll jumping. We use the built-in `enableGutterUtility` button for
commenting rather than a custom renderer, so both features coexist safely. If we
ever need a custom gutter, switch separators to `'line-info-basic'`.

---

## 7. Reading order

Agent-generated, read-only, regenerable. One per review — regenerating replaces
it, and progress and threads survive because they hang off the review and paths.

```
reading_order  (id, review_id unique, agent_run_id, created_at)
step           (id, reading_order_id, idx, title, guidance, attention('focus'|'skim'|null))
step_file      (step_id, idx, path, note)
file_viewed    (review_id, path, blob_sha, viewed_at)
```

**No step-level progress.** Progress is per-file "viewed" checks, GitHub-style:
keyed by `(review, path, blob_sha)`, so a file's check clears automatically when
its content changes. This survives jumping around out of order, which step
progress does not.

One step = an ordered list of files with short guidance and an optional
focus/skim attention level. Steps are the
navigation spine; the static file tree is the jump-anywhere escape hatch and
indicates which step a file belongs to.

---

## 8. Comments and anchoring

```
thread   (id, review_id, path, side, start_line, end_line,
          anchor_blob_sha, anchor_context_hash, status, outdated, created_at)
comment  (id, thread_id, author('user'|'agent'), body,
          agent_run_id, created_at)
```

Markdown throughout — agents write markdown, so `react-markdown` + `remark-gfm`,
with fenced code blocks highlighted through Pierre's `getSharedHighlighter()`.

Anchors store `(path, side, line range, blob SHA, hash of ±3 context lines)`.
They are re-anchored by diff mapping whenever the underlying content moves:

- you switch revision (`working` ↔ `head` ↔ `pr`),
- a file changes on disk in the attached worktree,
- the branch is amended, rebased, or force-pushed.

If mapping fails, the thread is marked `outdated` and shown with the code context
captured when it was written — never silently dropped, and never hidden the way
GitHub hides comments after a force-push. Designed in from the start; retrofitting
it is painful.

Threads are review-scoped, not revision-scoped, so a thread written against
uncommitted work is still there after you commit, push, and open a PR.

---

## 9. Agent integration

`@anthropic-ai/claude-agent-sdk`, embedded in the server.

### Runs
- **One `query()` per run.** A run is started by a button, the CLI, or the
  HTTP API; the request returns the `running` run immediately and the agent
  works in the background, reporting through `run.started` / `run.activity` /
  `run.ended` on the event channel. No HTTP request is held open for the
  length of a run.
- No token streaming: the reply appears whole when the agent posts it. The
  complete SDK messages are what get persisted. Each tool call emits
  a small `run.activity` event (`{reviewId, runId, label}`, e.g. "Reading
  `src/foo.ts`") for the ghost comment's activity line.
- **Cancel.** `POST /api/runs/:id/cancel` (CLI: `joinery run <id> --cancel`)
  aborts the run's `AbortController`; the run ends as `cancelled` with
  `run.ended` emitted, writes no reply or reading order, and records no error.
  A no-op for finished runs.
- `systemPrompt: {type:'preset', preset:'claude_code', append: <harness instructions>}`.
- `cwd` = the attached root when the review's branch is checked out, otherwise
  a cached detached agent worktree at the review's head (§4).
- `settingSources: []` — the reviewed repo's `.claude/settings*.json` (and your
  own settings) are **not** loaded, so a branch under review can't grant the
  agent tools this run deliberately withholds.
- Concurrency is unlimited: N concurrent runs, N subprocesses.
- **A server restart ends in-flight runs.** At startup, any run still
  `pending`/`running` is marked `error` ("the server restarted") and its
  working-indicator reaction is cleared.

**Not built yet** (deliberately deferred): long-lived sessions per thread fed
from a message queue so follow-ups push into a live run, `resume` +
`sessionId` + a persisted cursor so runs survive a restart, and `startup()`
pre-warming. The `session_id` / `resume_cursor` columns exist for that.

### Read-only enforcement
The embedded agent has **no shell and no write tools**:
- `disallowedTools: ['Write','Edit','NotebookEdit','Bash']`.
- `canUseTool` allows `Read`, `Grep`, `Glob` only for paths that resolve
  (through symlinks) under the run's `cwd`, and only with relative Glob
  patterns / Grep globs that don't climb out with `..`.
- It allows the in-process `joinery` tools (below); everything else — including
  any tool the SDK adds later — is denied by default.

### The `joinery` tools
Everything the agent does to the app goes through an in-process MCP server
(`agent/tools.ts`) whose tools are thin wrappers over the app's own HTTP routes,
invoked in-process — so validation, events, and side effects are exactly the
route's. Every tool is bound to the run's review; ids the model passes are
checked to belong to it.

Read: `get_review`, `list_files`, `get_diff`, `get_file`, `get_reading_order`,
`list_threads`, `get_thread`. Write: `reply`, `create_thread`,
`resolve_thread`, `react`, `mark_viewed`, `set_reading_order`,
`set_review_status`.

### Run kinds
| Kind | Trigger | Does |
|---|---|---|
| `reading_order` | "Generate reading order" button, or `joinery reading-order generate` | Explores the review root and returns a plan as structured output (`json_schema`), validated and persisted through the same path as `joinery reading-order set` |
| `thread_reply` | "Ask agent" on a thread, `Cmd+Enter` on a comment, or `POST /api/threads/:id/ask` | Seeded with the thread, its anchor and diff, and the review's reading order; puts an `eyes` reaction on the latest user comment while working, then acts through the `joinery` tools (reply, react, ...). If it ends having written nothing, a short fallback reply is posted |

Every complete SDK message is persisted to `agent_event(run_id, seq, type, payload)`,
so a run's work is replayable (`GET /api/runs/:id`) and survives a page reload.

```
agent_run (id, review_id, thread_id?, kind, status, session_id,
           resume_cursor, started_at, ended_at, error)
```

### Tools for the embedded agent, the CLI for everyone else
The embedded agent uses the in-process `joinery` tools rather than a shell:
no shell means no allowlist to get wrong, and the tools can be scoped to one
review. The `joinery` CLI stays the surface for humans and any outside Claude
Code session (`SKILL.md`) — both end up on the same HTTP routes.

---

## 10. HTTP API and CLI

Bearer token from `data/token` (or `$JOINERY_DATA_DIR/token`). Every CLI command supports `--json`.

| Method | Route | CLI |
|---|---|---|
| `GET` | `/api/repos` | `joinery repos list` |
| `POST` | `/api/repos` | `joinery repos add <path>` |
| `GET` | `/api/pulls/search?q=&repos=` | — (Explore: PRs of any state via the repo's forge; `q` is text or a PR number, `repos` are repo ids, default all with a supported forge; cached 60 s) |
| `GET` | `/api/reviews` | `joinery list` |
| `POST` | `/api/reviews` | `joinery create --branch <name> [--base <ref>]` |
| `GET` | `/api/reviews/:id` | `joinery show <id>` |
| `GET` | `/api/reviews/:id/files` | `joinery files <id>` |
| `GET` | `/api/reviews/:id/diff?path=&rev=` | `joinery diff <id> <path> [--rev working\|head\|pr]` |
| `GET` | `/api/reviews/:id/reading-order` | `joinery reading-order get <id>` |
| `PUT` | `/api/reviews/:id/reading-order` | `joinery reading-order set <id> --file plan.json` |
| `POST` | `/api/reviews/:id/reading-order/generate` | `joinery reading-order generate <id> [--model <model>]` |
| `GET` | `/api/reviews/:id/threads?status=` | `joinery threads <id> [--unresolved] [--markdown]` |
| `POST` | `/api/reviews/:id/threads` | `joinery comment <id> <path> --line N [--end M] [--side old\|new] --body-file c.md` |
| `GET` | `/api/threads/:id` | `joinery thread <id>` |
| `POST` | `/api/threads/:id/replies` | `joinery reply <id> --body-file r.md` |
| `POST` | `/api/threads/:id/resolve` | `joinery resolve <id>` |
| `POST` | `/api/threads/:id/ask` | — ("Ask agent" in the UI) |
| `GET` | `/api/comments/:id` | — (the agent's `react` ownership check) |
| `POST` | `/api/comments/:id/reactions` | `joinery react <commentId> <kind> [--off] [--actor user\|agent]` |
| `POST` | `/api/reviews/:id/revision` | `joinery revision <id> <working\|head\|pr>` |
| `POST` | `/api/reviews/:id/viewed` | `joinery viewed <id> <path>` |
| `GET` | `/api/runs/:id` | `joinery run <id>` |
| `POST` | `/api/runs/:id/cancel` | `joinery run <id> --cancel` |
| `WS` | `/api/events` | — (`watch`/`unwatch` topics: `home`, `repo:<id>`, `review:<id>`) |

`SKILL.md` ships alongside the CLI and documents the two workflows end to end:
producing a reading order, and answering a thread.

---

## 11. Keyboard and command palette

`Cmd+K` command palette (`cmdk`): jump to review, jump to file, jump to step,
jump to thread, switch revision (only the revisions that exist for the review),
switch theme, generate reading order. Asking an agent is deliberately not a
palette command — it happens from a thread.

Panel toggles follow the editor convention: `Cmd+B` for the left pane,
`Cmd+Opt+B` for the right. `T` alone toggles the threads panel, which overlays
the reading order rather than replacing it — so `Cmd+Opt+B` off and `T` on is a
valid, and common, state. Keys are declared as chords against a single modifier
map, so the eventual `Ctrl`/`Alt` reading costs one table, not a rewrite (§14).

`Cmd+W`, `Cmd+T`, `Cmd+N`, `Cmd+Q` can never be intercepted from a browser tab,
so nothing is bound to them. Launching in Chrome app mode
(`--app=http://localhost:7317`) or installing as a PWA gives a chromeless
window, a dock icon, and frees most of the rest.

| Key | Action |
|---|---|
| `j` / `k` | next / previous hunk |
| `n` / `p` | next / previous step |
| `]` / `[` | next / previous thread |
| `c` | comment on selected lines |
| `Cmd+Enter` | submit comment (in the composer; `Enter` inserts a newline) |
| composer's **Ask** button | submit and ask an agent to reply (no shortcut) |
| `r` | resolve thread |
| `Cmd+B` | toggle left panel (file tree) |
| `Cmd+Opt+B` | toggle right panel (reading order) |
| `t` | toggle threads panel (overlays the reading order) |
| `u` | unified / split (viewer-wide) |
| `e` / `Shift+E` | expand hunk context / expand whole file |
| `1` / `2` / `3` | revision: working / head / pr |
| `g h` | go homebase |
| `?` | shortcut help |

---

## 12. Phases

- **P0** Server, repo registry, branch-identity reviews (attach + object-store +
  revision picker), diff pipeline, `CodeView` + worker pool + changed-files
  `@pierre/trees`, all 75 themes, shadcn/Base UI shell, `lucide-react` icon set.
- **P0.5** The branch state engine (§5): two watches, `status`-derived file list,
  client-side set-diff, in-place `version` bumps, scroll anchoring,
  `WS /api/events`. Split out because it is the piece everything after it depends
  on being correct — thread re-anchoring (P2) and streaming replies (P3) both
  ride the same event channel.
- **P1** Reading order: agent generation via CLI, step navigation, per-file viewed checks.
- **P2** Comments: gutter utility, inline annotations, markdown, threads panel,
  anchoring.
- **P3** Real-time agent replies: unlimited concurrency, live activity UI, replay.
- **P4** Homebase, `Cmd+K`, full keymap, `joinery threads --markdown` export.
- **P4.5** Accessibility pass: axe audit, keyboard-only run-through, screen-reader
  walkthrough of a full review.
- **P5** *(deferred)* Windows and Linux support (§14).
- **P6** *(deferred)* Code intelligence. LSP first, against an attached root where
  one exists and the same lazily-created worktree an agent run uses where one
  does not; SCIP only later as a cold-start fast path.

---

## 13. Defaults I chose — flag any you disagree with

1. **Base ref** = `merge-base(origin/<default-branch>, <revision>)`, shared by all
   three revisions so they are comparable. Overridable per review.
2. **Default revision** = `working` when the branch is attached on disk,
   otherwise `head`.
3. **Regenerating a reading order replaces** the old one (one per review);
   threads and file-viewed state are preserved.
4. **`joinery threads --markdown`** is the outward path that substitutes for posting to GitHub.
5. **No agent auto-triggering.** Agents run only on a button press or a CLI call —
   never automatically on review creation.
6. **Diff style is viewer-wide only** (§6). No per-file override.

---

## 14. Future: other operating systems

**The MVP targets macOS only.** Not because the rest is hard, but because every
cross-platform accommodation in an unbuilt app is an abstraction written against
a guess. These are the findings, parked — implement them when there is a real
machine to test on.

**Linux.** The only genuine design pressure. The engine ignores watch event
payloads and treats every signal as "run a tick," which FSEvents makes free by
coalescing (measured: 51 events across five git operations). `inotify` does not
coalesce and imposes a per-user watch limit — `fs.inotify.max_user_watches`,
commonly 8192 — so a recursive watch on a 20k-file repo can simply fail to
register. Two viable fallbacks, neither chosen yet:

- Watch a shallow set (repo root, `$GIT_COMMON_DIR`, `src`-level dirs) and lean
  harder on the debounce plus a slow poll.
- Detect `ENOSPC` on watch registration and degrade to poll-only, with a visible
  "polling" indicator rather than a silent downgrade.

Either way the tick itself is unchanged — that is the property worth protecting,
and it comes for free from ignoring payloads.

**Windows.** Two known issues, both in path handling:

- **Path normalization.** §4 requires every path comparison to go through
  realpath. Windows adds 8.3 short names (`PROGRA~1`), drive-letter case
  (`C:` vs `c:`), and UNC versus mapped-drive spellings of the same directory.
  All of it lands in one `canonicalizePath()` function; the rest of the engine
  compares strings and does not care.
- **`git worktree` path semantics** and `$GIT_COMMON_DIR` resolution differ
  enough to warrant re-running the §4 verification suite (the `mv`-goes-stale
  case, scoped registry cleanup, detached-add-at-same-SHA) on Windows before
  trusting any of it.

Also: `ReadDirectoryChangesW` has its own buffer-overflow-under-load behavior,
distinct from both FSEvents and inotify.

**Keyboard.** `Cmd` reads as `Ctrl` and `Opt` as `Alt`. Shortcuts are declared as
chords against a single modifier map for exactly this reason, so it is one table
to swap, not a rewrite. `Cmd+K` becomes `Ctrl+K`, which does not collide with
anything a browser reserves.

**What is already portable and needs nothing.** Bun, Hono, `bun:sqlite`, Vite,
every Pierre package, the Claude Agent SDK, and every git plumbing command the
engine uses. The `data/` directory being app-local rather than in a user
dot-folder was chosen partly for this — no `%APPDATA%` versus `~/.config`
divergence to reconcile.

---

## 15. Reference

- `@pierre/diffs` docs: https://diffs.com/docs · https://diffs.com/llms-full.txt
- `@pierre/trees` docs: https://trees.software/ · https://trees.software/llms-full.txt
- Pierre source: https://github.com/pierrecomputer/pierre (Apache-2.0)
- Agent skills: `npx skills add pierrecomputer/pierre --skill diffs` (and `--skill trees`)
- `CodeView` live demo: https://diffshub.com
- Agent SDK: https://code.claude.com/docs/en/agent-sdk
- t3code Claude adapter (reference implementation):
  `apps/server/src/provider/Layers/ClaudeAdapter.ts` in `pingdotgg/t3code`
