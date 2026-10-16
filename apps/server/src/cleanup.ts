/**
 * Deleting a review or a whole repo for good, from the settings page. The
 * rows cascade on their own (`ON DELETE CASCADE`); this is the rest: live
 * agent runs are cancelled, the review's engine stopped, the refs Joinery
 * wrote under `refs/review/` dropped, and for a repo its agent worktrees
 * removed from disk. The user's clone and branches are never touched.
 */
import type { Review } from '@joinery/core';
import { removeAgentWorktree } from './agent/maintenance.ts';
import { cancelRun } from './agent/runs.ts';
import type { Invoke } from './agent/tools.ts';
import { deleteRepo, deleteReview, getRepoById, listReviews, listUnfinishedRuns, listWorktrees, type Db } from './db/index.ts';
import type { EngineRegistry } from './engine/index.ts';
import { unpinReviewRefs } from './git/index.ts';

export type CleanupDeps = {
  readonly db: Db;
  readonly registry: EngineRegistry;
  readonly invoke: Invoke;
};

/** Everything but the row itself, so a repo deletion can let its cascade take the rows. */
async function releaseReview(deps: CleanupDeps, review: Review, repoRoot: string | null): Promise<void> {
  const runs = (await listUnfinishedRuns(deps.db)).filter((r) => r.reviewId === review.id);
  for (const run of runs) {
    await cancelRun({ db: deps.db, invoke: deps.invoke, emit: (e) => deps.registry.dispatch(review.id, e) }, run.id);
  }
  // Stopped before the refs go, so a tick in flight can't write a pin back.
  deps.registry.dispose(review.id);
  if (repoRoot !== null) await unpinReviewRefs(review.id, { cwd: repoRoot });
}

export async function deleteReviewFully(deps: CleanupDeps, review: Review): Promise<void> {
  const repo = await getRepoById(deps.db, review.repoId);
  await releaseReview(deps, review, repo?.rootPath ?? null);
  await deleteReview(deps.db, review.id);
}

export async function deleteRepoFully(deps: CleanupDeps, repoId: string): Promise<void> {
  const repo = await getRepoById(deps.db, repoId);
  if (repo === null) return;
  for (const review of await listReviews(deps.db, { repoId })) {
    await releaseReview(deps, review, repo.rootPath);
  }
  for (const worktree of await listWorktrees(deps.db, repoId)) {
    try {
      await removeAgentWorktree(deps.db, worktree);
    } catch (err) {
      console.log(`[worktrees] could not remove ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await deleteRepo(deps.db, repoId);
}
