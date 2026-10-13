/**
 * Root resolution.
 *
 * One question: is there a live tree to follow, or not.
 *
 *   1. `working` needs a branch checked out *somewhere* -> attach there,
 *      create nothing.
 *   2. Anything else renders from the object store; it never touches the
 *      filesystem to decide where.
 *
 * `git worktree list --porcelain` is re-read on every tick: no
 * path conventions, no filesystem scanning, and a worktree an agent creates
 * mid-session starts being watched on the very next tick.
 */
import type { Repo, Review, RootBinding } from '@joinery/core';
import { canonicalizePath, findWorktreeForBranch, type WorktreeEntry } from '../git/index.ts';

export type RootResolution = RootBinding & {
  readonly worktree: WorktreeEntry | null;
};

export async function resolveRoot(repo: Repo, review: Review): Promise<RootResolution> {
  // A detached `(repo, sha)` review has no `working` revision at all.
  if (review.branch === null) {
    return { attachedPath: null, detachedReason: 'not-checked-out', worktree: null };
  }

  let entry: WorktreeEntry | null;
  try {
    entry = await findWorktreeForBranch(review.branch, { cwd: repo.rootPath });
  } catch {
    // The repo root itself is gone or unreadable.
    return { attachedPath: null, detachedReason: 'repo-unavailable', worktree: null };
  }

  if (entry === null) {
    return { attachedPath: null, detachedReason: 'not-checked-out', worktree: null };
  }

  try {
    const canonical = await canonicalizePath(entry.path);
    return { attachedPath: canonical, detachedReason: null, worktree: { ...entry, path: canonical } };
  } catch {
    // Registered but the directory itself vanished (rm -rf, unmounted, ...).
    return { attachedPath: null, detachedReason: 'directory-missing', worktree: null };
  }
}
