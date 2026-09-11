/**
 * Agent runs (SPEC §9). `generateReadingOrder` is the `reading_order` run
 * kind: it drives `@anthropic-ai/claude-agent-sdk` end to end (prompt,
 * read-only tool gating, structured output, schema validation) and persists
 * the result through the same `writeReadingOrderPlan` code path the CLI's
 * `review reading-order set --file plan.json` uses — see
 * `agent/readingOrder.ts` for the agent side and IMPROVEMENTS.md for what
 * of §9's full session machinery this does not implement.
 *
 * `requestThreadReply` (the `thread_reply` run kind) is untouched — still a
 * placeholder; out of scope for this unit.
 */
import type { AgentRun, FileEntry, ServerEvent } from '@review/core';
import { appendEvent, createRun, setRunError, setRunStatus, writeReadingOrderPlan, type Db } from '../db/index.ts';
import { generateReadingOrderPlan, ReadingOrderAgentError } from './readingOrder.ts';

export type RunsDeps = {
  readonly db: Db;
  readonly emit: (event: ServerEvent) => void;
};

/** What `generateReadingOrder` needs from the review's engine (SPEC §9: `cwd` = the review root). */
export type ReadingOrderContext = {
  readonly cwd: string;
  readonly files: readonly FileEntry[];
};

/**
 * `POST /api/reviews/:id/reading-order/generate` (§10). Creates a
 * `reading_order` run, runs the agent against `context.cwd` with
 * `context.files` as the changed-file list, validates its structured output
 * against `readingOrderPlanSchema`, and persists it via
 * `writeReadingOrderPlan` (the same path `review reading-order set` uses).
 * On any failure the run is marked `error` with a real message instead of
 * throwing — the HTTP route and the CLI both expect a run back either way.
 */
export async function generateReadingOrder(deps: RunsDeps, reviewId: string, context: ReadingOrderContext): Promise<AgentRun> {
  const run = await createRun(deps.db, { reviewId, kind: 'reading_order' });
  deps.emit({ type: 'run.started', reviewId, run });
  await setRunStatus(deps.db, run.id, 'running');

  try {
    const plan = await generateReadingOrderPlan({
      cwd: context.cwd,
      files: context.files,
      onMessage: async (message) => {
        const type = typeof (message as { type?: unknown }).type === 'string' ? (message as { type: string }).type : 'unknown';
        await appendEvent(deps.db, run.id, type, message);
      },
    });

    await writeReadingOrderPlan(deps.db, reviewId, plan, run.id);
    deps.emit({ type: 'reading_order.updated', reviewId });

    const ended = await setRunStatus(deps.db, run.id, 'done');
    deps.emit({ type: 'run.ended', reviewId, run: ended });
    return ended;
  } catch (err) {
    const message =
      err instanceof ReadingOrderAgentError || err instanceof Error
        ? err.message
        : `reading-order generation failed: ${String(err)}`;
    await setRunError(deps.db, run.id, message);
    const ended = await setRunStatus(deps.db, run.id, 'error');
    deps.emit({ type: 'run.ended', reviewId, run: ended });
    return ended;
  }
}

/**
 * `POST /api/threads/:id/replies` with `askAgent: true` (§10, §9). Same
 * placeholder shape as before: records the run, then reports that the SDK
 * isn't wired up for thread replies yet. The reply itself (a user or
 * already-authored agent comment) is still appended by the caller
 * regardless. Out of scope for this unit — see the task's scope note.
 */
export async function requestThreadReply(
  deps: RunsDeps,
  reviewId: string,
  threadId: string,
): Promise<AgentRun> {
  const run = await createRun(deps.db, { reviewId, threadId, kind: 'thread_reply' });
  deps.emit({ type: 'run.started', reviewId, run });

  await setRunError(
    deps.db,
    run.id,
    'Thread-reply agent runs are not wired up yet (out of scope for this unit — only reading-order generation was implemented).',
  );
  const ended = await setRunStatus(deps.db, run.id, 'error');
  deps.emit({ type: 'run.ended', reviewId, run: ended });
  return ended;
}
