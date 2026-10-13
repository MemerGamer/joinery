/**
 * Pure mapping tests for `runUiState` (apps/web/src/lib/runState.ts) — the
 * fix for the silent-failure bug where a 200 response carrying
 * `status: "error"` was thrown away by both `generateReadingOrder` call
 * sites. These tests pin the contract that the UI phase is derived from
 * `run.status`/`run.error` generically, never from a specific error string.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentRun } from '@joinery/core';
import { localRun, runUiState } from '../src/lib/runState.ts';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run_1',
    reviewId: 'rev_1',
    threadId: null,
    kind: 'reading_order',
    status: 'running',
    sessionId: null,
    startedAt: 0,
    endedAt: null,
    error: null,
    ...overrides,
  };
}

describe('runUiState', () => {
  it('is idle when there is no run', () => {
    expect(runUiState(null)).toEqual({ phase: 'idle' });
  });

  it('is pending for both pending and running statuses', () => {
    expect(runUiState(run({ status: 'pending' }))).toEqual({ phase: 'pending' });
    expect(runUiState(run({ status: 'running' }))).toEqual({ phase: 'pending' });
  });

  it('surfaces the real error text for an error status — the whole point of the fix', () => {
    const message = 'Agent SDK integration is not wired up yet (SPEC §9 is a later unit).';
    expect(runUiState(run({ status: 'error', error: message }))).toEqual({
      phase: 'error',
      message,
    });
  });

  it('falls back to a generic message only when the server sent no error text', () => {
    const state = runUiState(run({ status: 'error', error: null }));
    expect(state.phase).toBe('error');
    expect(state.phase === 'error' && state.message.length > 0).toBe(true);
  });

  it('treats a cancelled run as an error too', () => {
    const state = runUiState(run({ status: 'cancelled', error: 'stopped by user' }));
    expect(state).toEqual({ phase: 'error', message: 'stopped by user' });
  });

  it('is done for a successful run', () => {
    expect(runUiState(run({ status: 'done' }))).toEqual({ phase: 'done' });
  });
});

describe('localRun', () => {
  it('synthesizes a pending run shaped like a server AgentRun', () => {
    const r = localRun('rev_1', 'pending');
    expect(r.reviewId).toBe('rev_1');
    expect(r.status).toBe('pending');
    expect(r.error).toBeNull();
    expect(runUiState(r)).toEqual({ phase: 'pending' });
  });

  it('synthesizes an error run for a genuinely-thrown failure (network/non-2xx)', () => {
    const r = localRun('rev_1', 'error', 'Failed to reach the server.');
    expect(runUiState(r)).toEqual({ phase: 'error', message: 'Failed to reach the server.' });
  });
});
