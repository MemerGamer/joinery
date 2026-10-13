<p align="center">
  <img src="apps/web/public/joinery-wordmark-squircle-light.svg" alt="Joinery" width="420" />
</p>

A local-first, agent-native code review app. Joinery renders diffs fast, walks
you through a change with a generated reading order, and keeps comment threads
that Claude Code can answer asynchronously.

- **Homebase** is a dashboard with one row per branch across your registered
  repos, covering both local branches and open PRs. Each row shows what's
  waiting on you.
- **Review page** has three panes: the changed files, the diffs with inline
  threads, and the reading order.

Everything runs on your machine. State lives in SQLite under `data/`.

## Development

```sh
bun install
bun run dev      # server + web
bun run check    # typecheck + tests
```
