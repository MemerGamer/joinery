/**
 * Composes `ReviewSummary` for `GET /api/reviews` (§1): the DB aggregate
 * (`summarizeReviews`) plus per-review git stats plus the matching PR from
 * the `gh` cache. Lives at the top level (not `db/` or `git/`) because it
 * depends on both and belongs to neither.
 *
 * One review failing to resolve (a deleted branch, `gh` unavailable, a git
 * error) never fails the whole list — each review's enrichment is wrapped so
 * a failure degrades to the DB-only summary rather than 500ing the endpoint.
 */
import type { CiStatus, Repo, Review, ReviewSummary } from '@review/core';
import { getRepoById, listRepos, listViewedForReviews, summarizeReviews, type Db } from './db/index.ts';
import { computeReviewGitStats } from './git/reviewStats.ts';
import { getPullsCached } from './git/pullsCache.ts';
import type { ListOpenPullsResult, PullSummary } from './git/github.ts';

export type HomebaseDeps = { readonly db: Db };

/** Reviews are independent I/O (git spawns, `gh` calls) — cap concurrency rather than fire a hundred at once. */
const CONCURRENCY = 4;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** The PR matching `review`, by `prNumber` first, else `headRefName === review.branch` (§1). */
function findMatchingPull(review: Review, pulls: readonly PullSummary[]): PullSummary | null {
  if (review.prNumber !== null) {
    const byNumber = pulls.find((p) => p.number === review.prNumber);
    if (byNumber !== undefined) return byNumber;
  }
  if (review.branch !== null) {
    const byBranch = pulls.find((p) => p.headRefName === review.branch);
    if (byBranch !== undefined) return byBranch;
  }
  return null;
}

/**
 * Build the full `ReviewSummary[]` for `reviews` (§1): one `summarizeReviews`
 * call for every id, repos loaded once, then per review (bounded concurrency)
 * git stats + the matching PR. `options.refresh` bypasses the `gh` cache.
 */
export async function buildReviewSummaries(
  deps: HomebaseDeps,
  reviews: readonly Review[],
  options: { readonly refresh: boolean },
): Promise<ReviewSummary[]> {
  if (reviews.length === 0) return [];

  const [baseSummaries, repos, viewedByReview] = await Promise.all([
    summarizeReviews(deps.db, reviews.map((r) => r.id)),
    listRepos(deps.db),
    listViewedForReviews(
      deps.db,
      reviews.map((r) => r.id),
    ),
  ]);
  const baseById = new Map(baseSummaries.map((s) => [s.reviewId, s]));
  const repoById = new Map(repos.map((r) => [r.id, r]));

  // One `getPullsCached` call per repo, shared by every review in it, memoized here.
  const pullsByRepo = new Map<string, Promise<ListOpenPullsResult>>();
  const pullsFor = (repo: Repo): Promise<ListOpenPullsResult> => {
    let pending = pullsByRepo.get(repo.id);
    if (pending === undefined) {
      pending = getPullsCached(repo, { refresh: options.refresh }).catch(
        (): ListOpenPullsResult => ({ available: false, pulls: [] }),
      );
      pullsByRepo.set(repo.id, pending);
    }
    return pending;
  };

  return mapLimit(reviews, CONCURRENCY, async (review) => {
    const base = baseById.get(review.id) ?? emptySummary(review.id);
    try {
      const repo = repoById.get(review.repoId) ?? (await getRepoById(deps.db, review.repoId));
      if (repo === null || repo === undefined) return base;

      const [gitStats, pullsResult] = await Promise.all([computeReviewGitStats(repo, review), pullsFor(repo)]);
      const pull = findMatchingPull(review, pullsResult.pulls);

      const viewedRows = viewedByReview.get(review.id) ?? [];
      const viewedFiles =
        gitStats === null
          ? base.viewedFiles
          : (() => {
              const currentBlobByPath = new Map(gitStats.files.map((f) => [f.path, f.newBlob]));
              return viewedRows.filter((v) => currentBlobByPath.get(v.path) === v.blobSha).length;
            })();

      const ci: CiStatus | null = pull?.ci ?? null;

      return {
        ...base,
        title: pull?.title ?? gitStats?.subject ?? null,
        authorName: pull?.authorLogin ?? gitStats?.authorName ?? null,
        filesTotal: gitStats === null ? null : gitStats.files.length,
        additions: gitStats === null ? null : gitStats.additions,
        deletions: gitStats === null ? null : gitStats.deletions,
        headSha: gitStats?.headSha ?? null,
        headCommittedAt: gitStats?.committedAt ?? null,
        ci,
        draft: pull?.isDraft ?? false,
        viewedFiles,
      };
    } catch {
      // Any unexpected failure (git, gh, db) falls back to the DB-only summary.
      return base;
    }
  });
}

function emptySummary(reviewId: string): ReviewSummary {
  return {
    reviewId,
    openThreads: 0,
    resolvedThreads: 0,
    viewedFiles: 0,
    readingOrderVersion: null,
    agentRunning: false,
    lastActivityAt: null,
    title: null,
    authorName: null,
    filesTotal: null,
    additions: null,
    deletions: null,
    headSha: null,
    headCommittedAt: null,
    ci: null,
    draft: false,
    unreadAgentReplies: 0,
  };
}
