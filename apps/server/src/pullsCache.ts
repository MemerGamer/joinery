/**
 * Open pulls per repo, from `gh pr list`, behind a persisted
 * stale-while-revalidate cache (`storedCache.ts`): a network round trip
 * Homebase/Explore should never wait on once any answer is stored. Fresh for
 * 60 s; a failed fetch (`available: false`) never replaces a good answer.
 */
import type { Repo } from '@review/core';
import { getMe } from './git/me.ts';
import { listOpenPulls, type ListOpenPullsResult } from './git/github.ts';
import { createStoredCache, type StoredCacheDeps } from './storedCache.ts';

export type PullsCacheDeps = StoredCacheDeps;

const cache = createStoredCache<ListOpenPullsResult>({
  namespace: 'pulls',
  version: 1,
  staleAfterMs: 60_000,
  keepPrevious: (next, previous) => !next.available && previous.available,
});

export function getPullsCached(
  deps: PullsCacheDeps,
  repo: Repo,
  options?: { refresh?: boolean },
): Promise<ListOpenPullsResult> {
  return cache.get(
    deps,
    repo.id,
    async () => {
      // Warm the cached `gh` login first so `reviewRequested` reflects who's
      // asking, not just "someone was requested" (github.ts).
      await getMe(repo.rootPath);
      return listOpenPulls({ cwd: repo.rootPath });
    },
    options,
  );
}

/** For tests/debugging: forget every in-memory and in-flight entry (stored rows stay). */
export function clearPullsCache(): void {
  cache.clear();
}
