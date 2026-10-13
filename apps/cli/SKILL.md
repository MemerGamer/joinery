---
name: joinery-cli
description: Drive the joinery code review app from a Claude Code session — produce a reading order for a review, or answer a comment thread. Use whenever a task mentions "reading order", "review threads/comments", or the `joinery` CLI.
---

# review CLI

`joinery` is a local HTTP client for a running joinery server
(`http://127.0.0.1:7317` by default). It reads its bearer token from
`~/.joinery/data/token` for installed builds (`data/token` in the repo for source checkouts; `JOINERY_DATA_DIR` overrides either), and the
server URL from `JOINERY_URL`. Every subcommand supports `--json` for
machine-readable output — pipe it to `jq`.

**You are read-only with respect to the code under review.** Never edit,
`git commit`, or otherwise change files in the review root. Your only writes
go through this CLI: `joinery reading-order set` and `joinery reply`. Use
`Read`, `Grep`, `Glob`, and read-only `Bash` (`git log|show|diff|blame|status`,
`rg`, `ls`, `cat`, `head`, `sed -n`) to look at the code.

Run `joinery --help` for the full command list; `joinery <command> --help` for
one command.

## Workflow 1: produce a reading order

Triggered by `joinery reading-order generate <id>` (the server spawns you with
this as your task) or manually.

1. Look at what changed:
   ```
   joinery files <id> --json | jq -r '.list.files[].path'
   ```
2. Read the diffs that matter (`joinery diff <id> <path>`), and use read-only
   `git`/`rg`/`cat` in the review root to understand context around them.
3. Group the changed files into an ordered sequence of steps that tells the
   story of the change — foundational pieces first, call sites and tests
   last. Write it to `plan.json`:
   ```json
   {
     "steps": [
       {
         "title": "Add the retry policy type",
         "explanation_md": "`RetryPolicy` is the new shared type everything else in this change builds on.",
         "files": [
           { "path": "packages/core/src/domain/retry.ts", "note_md": "The policy shape and its defaults." }
         ]
       },
       {
         "title": "Wire it into the HTTP client",
         "explanation_md": "The client now retries per `RetryPolicy` instead of a fixed count.",
         "files": [
           { "path": "apps/cli/src/client.ts", "note_md": null },
           { "path": "apps/cli/test/client.test.ts", "note_md": "Covers the new backoff schedule." }
         ]
       }
     ]
   }
   ```
   Rules (from `readingOrderPlanSchema` in `@joinery/core`):
   - `steps`: at least one.
   - each step: non-empty `title`; `explanation_md` (markdown, defaults to `""`
     if omitted); `files`: at least one.
   - each file: non-empty `path` (must be one of the review's changed files);
     `note_md` (markdown or `null`, defaults to `null`).
   - every changed file should end up in exactly one step. Files you leave out
     land in an "unassigned" bucket in the UI — only do that on purpose.
4. Submit it:
   ```
   joinery reading-order set <id> --file plan.json
   ```
   Validation errors name the exact offending field, e.g.
   `steps[2].files[0].path: too_small` — fix `plan.json` and resubmit.

## Workflow 2: answer a thread

Triggered by "Ask agent" on a comment (`thread_reply` run). That embedded run
acts through in-process tools (`mcp__joinery__*`), not this CLI — it has no
shell at all. This workflow is for an *external* Claude Code session working
the same way a human would: it is seeded with the thread, its code context,
and the review's reading order, and talks to the server through `joinery`.

1. Read the thread:
   ```
   joinery thread <threadId> --json
   ```
2. Re-read the surrounding code (`joinery diff <reviewId> <path>`, read-only
   `git`/`rg`/`cat` in the review root) to ground your answer in what the code
   actually does now, not just the comment text.
3. Write your reply as markdown to a file, then submit it:
   ```
   cat > reply.md <<'EOF'
   Looking at `apps/cli/src/client.ts:42`, the retry only triggers on 5xx —
   ECONNREFUSED falls through to the caller. That matches `RetryPolicy.retryOn`
   in `packages/core/src/domain/retry.ts`; if you want connection errors
   retried too, that's the field to widen.
   EOF
   joinery reply <threadId> --body-file reply.md
   ```
   `--body-file -` reads the reply body from stdin instead of a file.
4. Only resolve the thread if you were explicitly asked to:
   ```
   joinery resolve <threadId>
   ```

## Reacting

`joinery react <commentId> <kind> [--off] [--actor user|agent] [--json]` sets
or clears a reaction on a comment. `<kind>` accepts either the enum value
(`thumbs_up`, `thumbs_down`, `eyes`, `check`, `question`, `tada`) or its
emoji (👍 👎 👀 ✅ ❓ 🎉). `--actor` defaults to `user`; pass `--actor agent`
when reacting as yourself. `--off` removes the reaction instead of setting it.

Three status conventions, so a reaction reads the same everywhere in the app:
- `eyes` — react on a thread's latest comment when you start working on it
  from an external session (the embedded run does this automatically).
- `check` — react once you've addressed what was asked, if you're not also
  posting a reply.
- `thumbs_up` — acknowledge a comment without writing a reply at all.

```
joinery react abc123 eyes --actor agent
joinery react abc123 check --actor agent
joinery react abc123 eyes --off --actor agent
```

## Useful one-liners

```
joinery list --json | jq -r '.reviews[] | "\(.id)\t\(.branch)\t\(.status)"'
joinery threads <reviewId> --unresolved --json | jq -r '.threads[] | .id'
joinery feedback <reviewId> --unresolved   # markdown summary, for a human to paste anywhere
joinery show <reviewId> --json | jq '.state'
```

## Exit codes

`0` success · `1` runtime/API error (server unreachable, not found, etc. —
message and an optional hint on stderr) · `2` usage error (bad flags/args).
