# Demo instance

A fake but realistic Joinery setup for README screenshots and demo videos. It
uses its own data dir and port, so your real `data/` is never touched, and it
needs no network, `gh` auth, or Claude calls (the repos get fake github.com remotes served from local bare clones, and a
fake `gh` in `scripts/demo/bin` answers with canned PR data).

## Seed

```sh
bun scripts/demo/seed.ts
```

Re-runnable: it wipes and rebuilds `/tmp/joinery-demo` (override with
`JOINERY_DEMO_DIR`; seed port with `JOINERY_DEMO_PORT`, default 7318). It
creates the fake git repos under `/tmp/joinery-demo/repos/`, starts a
throwaway server, fills it through the HTTP API, backdates timestamps, and
stops the server again.

## Start

```sh
# (use the env from scripts/demo/env.ts for the fake gh + identity, or just run capture.ts)
JOINERY_DATA_DIR=/tmp/joinery-demo/data JOINERY_PORT=7318 bun apps/server/src/index.ts
```

The server serves the built web app from `apps/web/dist` (run
`bun run --filter '@joinery/web' build` first if it is missing or stale).
Open <http://127.0.0.1:7318>. Stop with Ctrl-C.

The Vite dev server proxies `/api` to port 7317 only, so for the demo use the built app above (or run the demo server with `JOINERY_PORT=7317` while your real instance is stopped).

## Pages

- Homebase: <http://127.0.0.1:7318/>
- Reviews are opened from Homebase. The richest one is
  `feat/prorate-plan-changes` in `billing-service`: a 5-step reading order,
  a renamed file, 4 open threads and 1 resolved, Claude replies, and some
  files marked viewed. Its id is shown by
  `curl -s -H "authorization: Bearer $(cat /tmp/joinery-demo/data/token)" http://127.0.0.1:7318/api/reviews`;
  open it at `http://127.0.0.1:7318/` and click the row.

## What is seeded

`billing-service` (TypeScript, Hono + Stripe), authors Priya Raman, Marcus
Webb, Sofia Lindqvist, and the reviewer John Doe:

| Branch | State |
| --- | --- |
| `feat/prorate-plan-changes` | open review, reading order, 5 threads (agent replies, a reaction), 3 files viewed, unread agent replies |
| `fix/webhook-signature-replay` | open review, reading order, 1 open + 1 resolved thread |
| `refactor/retry-with-backoff` | open review, nothing reviewed yet |
| `feat/dunning-emails` | draft review, checked out in a worktree with uncommitted edits |

`storefront-web` (React): `feat/cart-drawer`, open review with a reading
order and one thread answered by Claude.

## Capture README media

```sh
bun run --filter '@joinery/web' build   # make sure apps/web/dist is fresh
bunx playwright install chromium        # once
bun scripts/demo/capture.ts             # or: ... shots | ... video
```

Re-seeds the demo, runs its own server on the demo port, and writes to
`docs/media/`: `demo.mp4` (2560x1600 HiDPI walkthrough with a fake cursor, click
ripples and smooth zooms) and the Tour screenshots `homebase.png` (1x), `explore.png`,
`review.png`, `thread.png` (2x). The browser is preset like a
user would (`joinery:theme` = Pierre Dark Soft, `homebase.backdrop` = Nocturne).
Needs `ffmpeg` on PATH. The reviewer identity comes from a demo gitconfig
(`GIT_CONFIG_GLOBAL`, see `env.ts`); your real git config is untouched.

Video notes: Playwright's `recordVideo` is low-res, so frames come from CDP
`Page.startScreencast` in a Chromium launched with
`--force-device-scale-factor=2` (the per-context option is ignored by the
screencast), timestamps become a constant-30fps MP4 via ffmpeg's concat demuxer,
and the zooms are applied in ffmpeg from recorded keyframes. (A CSS transform on
the page makes the diff virtualizer mis-measure and scroll.)

If you start the server by hand, use the same env as `env.ts` (`demoEnv`) to
get the fake `gh` and identity.
