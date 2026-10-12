/**
 * Composes `ReviewSummary` for `GET /api/reviews`: the DB aggregate
 * (`summarizeReviews`) plus per-review git stats plus the matching PR from
 * the `gh` cache. Lives at the top level (not `db/` or `git/`) because it
 * depends on both and belongs to neither.
 *
 * Git stats and `me` sit behind persisted stale-while-revalidate caches
 * (`storedCache.ts`), like pulls: the list answers from the last known
 * values and checks git/`gh` behind them, pushing `reviews.changed` when
 * something moved.
 *
 * One review failing to resolve (a deleted branch, `gh` unavailable, a git
 * error) never fails the whole list — each review's enrichment is wrapped so
 * a failure degrades to the DB-only summary rather than 500ing the endpoint.
 */
import type { CiStatus, Repo, Review, ReviewSummary } from '@review/core';
import { getRepoById, listRepos, listViewedForReviews, summarizeReviews } from './db/index.ts';
import { computeReviewGitStats } from './git/reviewStats.ts';
import { getMe, type Me } from './git/me.ts';
import { getPullsCached } from './pullsCache.ts';
import { createStoredCache, type StoredCacheDeps } from './storedCache.ts';
import type { ListOpenPullsResult, PullSummary } from './git/github.ts';

export type HomebaseDeps = StoredCacheDeps;

/**
 * What a Homebase card needs from `ReviewGitStats`, and all that's stored:
 * the file list shrinks to `path -> newBlob`, enough to count which viewed
 * marks still match the current file.
 */
type HomeReviewStats = {
  readonly headSha: string;
  readonly subject: string | null;
  readonly authorName: string | null;
  readonly committedAt: number | null;
  readonly additions: number;
  readonly deletions: number;
  readonly blobByPath: Readonly<Record<string, string | null>>;
};

async function loadHomeReviewStats(repo: Repo, review: Review): Promise<HomeReviewStats | null> {
  const stats = await computeReviewGitStats(repo, review);
  if (stats === null) return null;
  return {
    headSha: stats.headSha,
    subject: stats.subject,
    authorName: stats.authorName,
    committedAt: stats.committedAt,
    additions: stats.additions,
    deletions: stats.deletions,
    blobByPath: Object.fromEntries(stats.files.map((f) => [f.path, f.newBlob])),
  };
}

/**
 * Rechecked at most every 5 s per review: a recheck is two `rev-parse`/
 * `merge-base` spawns, and only a moved head/base costs the full rebuild
 * (`computeReviewGitStats` keeps its own sha-keyed cache).
 */
const reviewStatsCache = createStoredCache<HomeReviewStats | null>({
  namespace: 'reviewStats',
  version: 1,
  staleAfterMs: 5_000,
  concurrency: 4,
});

/** `getMe` resolves once per process; this only spares a restart the wait on `gh api user`. */
const meCache = createStoredCache<Me>({
  namespace: 'me',
  version: 1,
  staleAfterMs: 60_000,
  // A half-resolved `Me` (offline `gh`) never replaces a fully resolved one.
  keepPrevious: (next, previous) =>
    (next.login === null && previous.login !== null) || (next.name === null && previous.name !== null),
});

/** `me` for `GET /api/me`, from the first registered repo (or the server's cwd). */
export async function getMeCached(deps: HomebaseDeps): Promise<Me> {
  const repos = await listRepos(deps.db);
  const cwd = repos[0]?.rootPath ?? null;
  return meCache.get(deps, 'me', () => getMe(cwd));
}

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

/** The PR matching `review`, by `prNumber` first, else `headRefName === review.branch`. */
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
 * Build the full `ReviewSummary[]` for `reviews`: one `summarizeReviews`
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
      pending = getPullsCached(deps, repo, { refresh: options.refresh }).catch(
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

      const [gitStats, pullsResult] = await Promise.all([
        reviewStatsCache.get(deps, review.id, () => loadHomeReviewStats(repo, review)),
        pullsFor(repo),
      ]);
      const pull = findMatchingPull(review, pullsResult.pulls);

      const viewedRows = viewedByReview.get(review.id) ?? [];
      const viewedFiles =
        gitStats === null
          ? base.viewedFiles
          : viewedRows.filter((v) => gitStats.blobByPath[v.path] === v.blobSha).length;

      const ci: CiStatus | null = pull?.ci ?? null;

      return {
        ...base,
        title: pull?.title ?? gitStats?.subject ?? null,
        authorName: pull?.authorLogin ?? gitStats?.authorName ?? null,
        filesTotal: gitStats === null ? null : Object.keys(gitStats.blobByPath).length,
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
