/**
 * The PR behind one review, in full (forge `viewPull`), behind the same
 * persisted stale-while-revalidate cache as the pulls list (`storedCache.ts`).
 * Keyed by review id, so a review matched to its PR by branch resolves the
 * number once per refresh. Fresh for a few minutes; a failed fetch (`null`)
 * never replaces a good answer.
 */
import type { PullDetail, Repo, Review } from '@joinery/core';
import { forgeFor } from './git/forge/index.ts';
import { createStoredCache, type StoredCacheDeps } from './storedCache.ts';

const cache = createStoredCache<PullDetail | null>({
  namespace: 'pull-detail',
  version: 1,
  staleAfterMs: 3 * 60_000,
  keepPrevious: (next, previous) => next === null && previous !== null,
});

export function getPullDetailCached(
  deps: StoredCacheDeps,
  repo: Repo,
  review: Review,
  options?: { refresh?: boolean },
): Promise<PullDetail | null> {
  return cache.get(
    deps,
    review.id,
    async () => {
      const cwd = repo.rootPath;
      const forge = forgeFor(repo);
      const number =
        review.prNumber ?? (review.branch === null ? null : await forge.findOpenPrNumberForBranch(review.branch, { cwd }));
      return number === null ? null : forge.viewPull(number, { cwd });
    },
    options,
  );
}
