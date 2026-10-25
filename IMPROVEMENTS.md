# Improvements

What's still open. Parked on purpose, not forgotten. Resolved notes and the
history behind them live in git (`git log -p -- IMPROVEMENTS.md`).

## Not built yet

- **Long-lived agent sessions.** Each run is a single `query()`.
  Not built: follow-ups pushed into a live session, `resume` after a
  restart (a restart just marks in-flight runs `error`), and `startup()`
  pre-warming. The `session_id` / `resume_cursor` columns on `agent_run` are
  unused.
- **Commit/SHA range picker and "changes since you last looked".**
  Planned as a GitHub-style picker for a commit or range of commits, with
  "since you last looked" as one preset. `review.last_seen_pr_sha` exists
  but nothing writes or reads it.
- **Per-review base ref override.** `baseRef` is set once when
  the review is created. There is no route or CLI command to change it.
- **Accessibility pass.** No axe audit, keyboard-only
  run-through, or screen-reader walkthrough yet.
- **Windows/Linux (P5) and code intelligence (P6).** Deferred in the spec.

## Agents

- **The thread-reply prompt has no PR title.** Branch, base and PR number
  are there. The title needs the `gh`-backed lookup Homebase uses, which is
  real latency on every run.
- **The live "Thinking…" row doesn't render on a thread that is both
  outdated and collapsed to its anchor-context view.** That branch replaces
  the comment list with a `<pre>`, so the row has nowhere to go.
- **Not verified end to end against a live server and a real agent run**
  (typecheck, tests and the web build pass). This covers the reply agent,
  its `joinery` tools, reactions, background runs, and orphaned-run cleanup.

## Web

- **Homebase live updates cover writes through the API only.** Things that
  happen outside it, like a push to a branch no review window is watching or
  a new PR, still show up on window focus or a manual refresh. Covers them
  would take a server-side watch or poll.
- **Command-palette search lists aren't virtualized.** cmdk mounts every
  matching item, which costs something on a PR with hundreds of files.
- **The cmdk dialog has no `Dialog.Description`.** Radix logs an a11y
  warning in dev. It comes from inside cmdk's own dialog wrapper.
- **`ReviewCodeView.tsx`'s density tweak relies on undocumented
  `@pierre/diffs` custom properties** (`--diffs-gap-block`,
  `--diffs-line-height`). A version bump could rename them without a type
  error.
- **`@pierre/trees` colors come from its own tokens**
  (`--trees-bg`/`--trees-fg`/...), not the app's `--chrome-*` ones. They
  look close today. If the file tree ever looks slightly off in one theme,
  wire the `--trees-*-override` variables to `--chrome-*`.

## Server / git

- **A `git am` in progress is reported as `rebase`.** Both leave
  `$GIT_DIR/rebase-apply`. Telling them apart needs a look at
  `rebase-apply/applying`.
- **`GitError.subcommand` is just `args[0]`** (`"worktree"`, not
  `"worktree add"`). Callers that need more detail inspect `.args`.

## Tests

- **`engine tick > committing moves head while working looks identical`
  fails**, on `main` as well as on feature branches. It needs a root-cause
  look. Don't skip it.
