/**
 * Maps an `AgentRun` to what the UI should show for it. A 200
 * response carrying `status: "error"` is the trap this exists to defuse —
 * callers must branch on `run.status`/`run.error`, never on HTTP status
 * alone, and never on the specific error text (the agent side is being
 * rewritten concurrently, so the message is arbitrary and may change).
 */
import type { AgentRun } from '@joinery/core';

export type RunUiState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'error'; message: string }
  | { phase: 'done' };

const FALLBACK_ERROR_MESSAGE = 'The run failed with no further details.';

/** Pure: derive the UI-facing phase from a run object (or its absence). */
export function runUiState(run: AgentRun | null): RunUiState {
  if (run === null) return { phase: 'idle' };
  switch (run.status) {
    case 'pending':
    case 'running':
      return { phase: 'pending' };
    case 'cancelled':
      // The user's own doing: nothing to report.
      return { phase: 'idle' };
    case 'error':
      return { phase: 'error', message: run.error ?? FALLBACK_ERROR_MESSAGE };
    case 'done':
      return { phase: 'done' };
  }
}

/**
 * A locally-synthesized run for the two moments a real `AgentRun` doesn't
 * exist yet: the optimistic click (before the POST resolves) and a
 * genuinely-thrown failure (network error, non-2xx) that never produced a
 * server-side run object at all. Shaped exactly like a server `AgentRun` so
 * `runUiState` needs no special case for it.
 */
export function localRun(
  reviewId: string,
  status: 'pending' | 'error',
  error: string | null = null,
): AgentRun {
  const now = Date.now();
  return {
    id: `local_${now}_${Math.random().toString(36).slice(2)}`,
    reviewId,
    threadId: null,
    kind: 'reading_order',
    status,
    sessionId: null,
    startedAt: now,
    endedAt: status === 'error' ? now : null,
    error,
  };
}
