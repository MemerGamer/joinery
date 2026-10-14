/**
 * Open pulls per repo, from the repo's forge, behind a persisted
 * stale-while-revalidate cache (`storedCache.ts`): a network round trip
 * Homebase/Explore should never wait on once any answer is stored. Fresh for
 * 60 s; a failed fetch (`available: false`) never replaces a good answer.
 */
import type { Repo } from '@joinery/core';
import { getMe } from './git/me.ts';
import { forgeFor, type ListOpenPullsResult } from './git/forge/index.ts';
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
      // Resolve the login first so `reviewRequested` reflects who's asking,
      // not just "someone was requested" (forge/github.ts).
      const forge = forgeFor(repo);
      const { login } = await getMe(repo.rootPath, forge, repo.remoteHost);
      return forge.listOpenPulls({ cwd: repo.rootPath, login });
    },
    options,
  );
}

/** For tests/debugging: forget every in-memory and in-flight entry (stored rows stay). */
export function clearPullsCache(): void {
  cache.clear();
}
