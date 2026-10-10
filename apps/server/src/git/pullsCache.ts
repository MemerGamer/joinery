/**
 * A short-lived, per-repo cache in front of `listOpenPulls`: `gh pr list`
 * is a network round trip, and
 * Homebase/Explore both want it warm without hammering `gh` on every
 * keystroke or focus refetch.
 *
 * - 60 s TTL, keyed by `repo.id`.
 * - In-flight calls are deduped: two callers racing for the same repo share
 *   one `gh` invocation rather than firing two.
 * - `refresh: true` bypasses the TTL, but a `refresh` call still joins an
 *   already-in-flight fetch for that repo instead of starting a second one.
 */
import type { Repo } from '@review/core';
import { listOpenPulls, type ListOpenPullsResult } from './github.ts';

const TTL_MS = 60_000;

type CacheEntry = {
  expiresAt: number;
  result: ListOpenPullsResult;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ListOpenPullsResult>>();

export async function getPullsCached(
  repo: Repo,
  options?: { refresh?: boolean },
): Promise<ListOpenPullsResult> {
  const refresh = options?.refresh ?? false;
  const cached = cache.get(repo.id);
  if (!refresh && cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const existing = inFlight.get(repo.id);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    try {
      const result = await listOpenPulls({ cwd: repo.rootPath });
      cache.set(repo.id, { expiresAt: Date.now() + TTL_MS, result });
      return result;
    } finally {
      inFlight.delete(repo.id);
    }
  })();
  inFlight.set(repo.id, promise);
  return promise;
}

/** For tests/debugging: forget every cached and in-flight entry. */
export function clearPullsCache(): void {
  cache.clear();
  inFlight.clear();
}
