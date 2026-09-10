/**
 * Agent runs (SPEC §9) — thin for now. This unit does not integrate
 * `@anthropic-ai/claude-agent-sdk`; that is a later unit. What lives here is
 * just enough for the HTTP surface (§10) and the CLI's `review
 * reading-order set` workflow to work end to end: `agent_run` rows,
 * `run.*` events, and a `pending` placeholder for generation until the SDK
 * is wired up.
 */
import type { AgentRun, ServerEvent } from '@review/core';
import { createRun, setRunError, setRunStatus, type Db } from '../db/index.ts';

export type RunsDeps = {
  readonly db: Db;
  readonly emit: (event: ServerEvent) => void;
};

/**
 * `POST /api/reviews/:id/reading-order/generate` (§10). Creates a
 * `reading_order` run and immediately marks it `error` with an explanatory
 * message, rather than pretending to run an agent that isn't wired up yet.
 * The CLI path (`review reading-order set --file plan.json`) is the
 * supported workflow until the SDK integration lands.
 */
export async function generateReadingOrder(deps: RunsDeps, reviewId: string): Promise<AgentRun> {
  const run = await createRun(deps.db, { reviewId, kind: 'reading_order' });
  deps.emit({ type: 'run.started', reviewId, run });

  const errored = await setRunError(
    deps.db,
    run.id,
    'Agent SDK integration is not wired up yet (SPEC §9 is a later unit). ' +
      'Use `review reading-order set --file plan.json` to set a reading order directly.',
  );
  const ended = await setRunStatus(deps.db, run.id, 'error');
  void errored;
  deps.emit({ type: 'run.ended', reviewId, run: ended });
  return ended;
}

/**
 * `POST /api/threads/:id/replies` with `askAgent: true` (§10, §9). Same
 * placeholder shape as `generateReadingOrder`: records the run, then reports
 * that the SDK isn't wired up. The reply itself (a user or already-authored
 * agent comment) is still appended by the caller regardless.
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
    'Agent SDK integration is not wired up yet (SPEC §9 is a later unit).',
  );
  const ended = await setRunStatus(deps.db, run.id, 'error');
  deps.emit({ type: 'run.ended', reviewId, run: ended });
  return ended;
}
