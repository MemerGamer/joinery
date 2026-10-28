/**
 * Agent runs. `generateReadingOrder` is the `reading_order` run
 * kind: it drives `@anthropic-ai/claude-agent-sdk` end to end (prompt,
 * read-only tool gating, structured output, schema validation) and persists
 * the result through the same `writeReadingOrderPlan` code path the CLI's
 * `joinery reading-order set --file plan.json` uses.
 * See `agent/readingOrder.ts` for the agent side; the full session machinery
 * is deliberately not implemented there.
 *
 * `requestThreadReply` is the `thread_reply` run kind: create the run, put an
 * `eyes` reaction (as the agent) on
 * the thread's latest user comment as a working indicator, run the agent
 * (`threadReply.ts`) against the `joinery` MCP tools, then remove the `eyes`
 * reaction and close out the run — on success or on error either way, so a
 * run never leaves a stray `eyes` reaction behind.
 *
 * Both run kinds return their `running` run as soon as it's recorded; the
 * agent itself runs in the background and reports back through `run.*`
 * events, so no HTTP request is held open for the length of an agent run.
 */
import type { AgentModel, AgentRun, FileEntry, Review, ServerEvent } from '@joinery/core';
import {
  appendEvent,
  createRun,
  getRun,
  getThreadWithComments,
  setRunError,
  setRunStatus,
  writeReadingOrderPlan,
  type Db,
} from '../db/index.ts';
import { generateReadingOrderPlan, ReadingOrderAgentError } from './readingOrder.ts';
import { buildReviewContext, loadReviewContext } from './reviewContext.ts';
import { runThreadReplyAgent } from './threadReply.ts';
import type { Invoke } from './tools.ts';
import type { EngineForCwd } from './worktree.ts';

/** Live runs by id: the controller that aborts the agent, and a promise that settles once the run row is closed out. */
const activeRuns = new Map<string, { controller: AbortController; ended: Promise<void> }>();

export type RunsDeps = {
  readonly db: Db;
  readonly invoke: Invoke;
  readonly emit: (event: ServerEvent) => void;
};

/** What `generateReadingOrder` needs from the review's engine (`cwd` = the review root). */
export type ReadingOrderContext = {
  readonly cwd: string;
  readonly review: Review;
  readonly files: readonly FileEntry[];
  /** The model for the run; Claude Code's own default when absent. */
  readonly model?: AgentModel;
};

/**
 * `POST /api/reviews/:id/reading-order/generate`. Creates a
 * `reading_order` run, marks it `running`, and returns it straight away;
 * the agent itself runs in the background (see `runInBackground`). It
 * explores `context.cwd` with `context.files` as the changed-file list, its
 * structured output is validated against `readingOrderPlanSchema`, and the
 * plan is persisted via `writeReadingOrderPlan` (the same path
 * `joinery reading-order set` uses). Completion is reported through
 * `reading_order.updated` and `run.ended`; on any failure the run is marked
 * `error` with a real message.
 */
export async function generateReadingOrder(deps: RunsDeps, reviewId: string, context: ReadingOrderContext): Promise<AgentRun> {
  const created = await createRun(deps.db, { reviewId, kind: 'reading_order' });
  deps.emit({ type: 'run.started', reviewId, run: created });
  const run = await setRunStatus(deps.db, created.id, 'running');

  runInBackground(deps, reviewId, run.id, async (signal) => {
    if (context.files.length === 0) {
      throw new ReadingOrderAgentError('review has no changed files to build a reading order from');
    }
    const plan = await generateReadingOrderPlan({
      cwd: context.cwd,
      context: buildReviewContext(await loadReviewContext(deps.db, context.review, context.files)),
      invoke: deps.invoke,
      reviewId,
      runId: run.id,
      abortController: signal,
      ...(context.model === undefined ? {} : { model: context.model }),
      onMessage: async (message) => {
        const type = typeof (message as { type?: unknown }).type === 'string' ? (message as { type: string }).type : 'unknown';
        await appendEvent(deps.db, run.id, type, message);
      },
    });
    signal.signal.throwIfAborted();
    await writeReadingOrderPlan(deps.db, reviewId, plan, run.id);
    deps.emit({ type: 'reading_order.updated', reviewId });
  }, {
    describeError: (err) =>
      err instanceof ReadingOrderAgentError || err instanceof Error ? err.message : `reading-order generation failed: ${String(err)}`,
  });

  return run;
}

/**
 * `POST /api/threads/:id/ask`, and the same trigger `createThread`/
 * `reply` fire with `askAgent: true` — "the latest user message in this
 * thread, in the context of the thread and the review".
 * Returns the `running` run straight away; the agent runs in the
 * background. `engine` is whichever engine the caller already resolved for
 * `review.id` (routes.ts holds one per request); `resolveRunCwd` (via
 * `runThreadReplyAgent`) decides whether that means the attached root or a
 * cached detached worktree.
 */
export async function requestThreadReply(
  deps: RunsDeps,
  review: Review,
  threadId: string,
  engine: EngineForCwd,
  model?: AgentModel,
): Promise<AgentRun> {
  const reviewId = review.id;
  const created = await createRun(deps.db, { reviewId, threadId, kind: 'thread_reply' });
  deps.emit({ type: 'run.started', reviewId, run: created });
  const run = await setRunStatus(deps.db, created.id, 'running');

  const thread = await getThreadWithComments(deps.db, threadId);
  const latestUserComment = thread === null ? undefined : [...thread.comments].reverse().find((c) => c.author === 'user');
  const setEyes = async (on: boolean): Promise<void> => {
    if (latestUserComment === undefined) return;
    await deps.invoke('POST', `/api/comments/${encodeURIComponent(latestUserComment.id)}/reactions`, {
      kind: 'eyes',
      actor: 'agent',
      on,
    });
  };
  await setEyes(true);

  runInBackground(deps, reviewId, run.id, async (signal) => {
    try {
      if (thread === null) throw new Error(`thread ${threadId} not found`);
      await runThreadReplyAgent(deps, run.id, review, thread, engine, signal, model);
    } catch (err) {
      // A cancel is not a failure: no "Agent run failed" reply.
      if (signal.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : `thread-reply agent run failed: ${String(err)}`;
      await deps.invoke('POST', `/api/threads/${encodeURIComponent(threadId)}/replies`, {
        body: `Agent run failed: ${message}`,
        author: 'agent',
        agentRunId: run.id,
      });
      throw err;
    } finally {
      await setEyes(false);
    }
  }, {
    describeError: (err) => (err instanceof Error ? err.message : `thread-reply agent run failed: ${String(err)}`),
  });

  return run;
}

/**
 * `POST /api/runs/:id/cancel`. Aborts the run's agent and waits for the run
 * to be closed out as `cancelled` (`run.ended` is emitted by then). A no-op
 * for a run that already finished; a `running` row with no live agent behind
 * it (an orphan) is closed out directly.
 */
export async function cancelRun(deps: RunsDeps, runId: string): Promise<AgentRun | null> {
  const run = await getRun(deps.db, runId);
  if (run === null) return null;
  if (run.status !== 'pending' && run.status !== 'running') return run;
  const active = activeRuns.get(runId);
  if (active === undefined) {
    const ended = await setRunStatus(deps.db, runId, 'cancelled');
    deps.emit({ type: 'run.ended', reviewId: run.reviewId, run: ended });
    return ended;
  }
  active.controller.abort();
  await active.ended;
  return getRun(deps.db, runId);
}

/**
 * Runs `body` detached from the HTTP request that started the run, then
 * closes the run out as `done` (`cancelled` if `cancelRun` aborted it, `error`
 * with `describeError`'s message otherwise) and emits `run.ended`. Never
 * rejects — a failure here has no caller left to report to, so it lands on
 * the run row and the event stream instead.
 */
function runInBackground(
  deps: RunsDeps,
  reviewId: string,
  runId: string,
  body: (controller: AbortController) => Promise<void>,
  options: { describeError: (err: unknown) => string },
): void {
  const controller = new AbortController();
  const ended = (async () => {
    let status: 'done' | 'error' | 'cancelled' = 'done';
    try {
      await body(controller);
      if (controller.signal.aborted) status = 'cancelled';
    } catch (err) {
      if (controller.signal.aborted) {
        status = 'cancelled';
      } else {
        status = 'error';
        await setRunError(deps.db, runId, options.describeError(err)).catch(() => undefined);
      }
    }
    try {
      const run = await setRunStatus(deps.db, runId, status);
      deps.emit({ type: 'run.ended', reviewId, run });
    } catch (err) {
      console.error(`agent run ${runId}: failed to record its end`, err);
    } finally {
      activeRuns.delete(runId);
    }
  })();
  activeRuns.set(runId, { controller, ended });
}
