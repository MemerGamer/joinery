<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/joinery-wordmark-squircle-dark.svg" />
    <img src="apps/web/public/joinery-wordmark-squircle-light.svg" alt="Joinery" width="420" />
  </picture>
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

## Install

Joinery runs on macOS (Apple Silicon). You'll need `git`, the GitHub CLI
(`gh auth login`), and Claude Code (logged in) on your PATH.

```sh
curl -fsSL https://raw.githubusercontent.com/szhabolcs/joinery/main/scripts/install.sh | sh
```

This installs to `~/.joinery`, links `joinery` into `~/.local/bin`, and starts
the server as a background service (a LaunchAgent).

```sh
joinery open      # open the web UI
joinery update    # update to the latest release and restart
```

To uninstall:

```sh
joinery service uninstall
rm -rf ~/.joinery ~/.local/bin/joinery
```

Your data lives in `~/.joinery/data`, so keep it if you plan to reinstall.

## Development

```sh
bun install
bun run dev      # server + web
bun run check    # typecheck + tests
```

## Releasing

Bump `version` in the root `package.json`, then tag and push. GitHub Actions
builds the tarball and publishes the release.

```sh
git tag vX.Y.Z && git push --tags
```
