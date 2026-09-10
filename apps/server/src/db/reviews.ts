/**
 * `review` — one row per `(repo, branch)` (§4). A detached review starts as
 * `(repo, pinned_sha)` with a null branch and adopts one later, in place.
 */
import { review } from '@review/core/db';
import type { Review, ReviewStatus, Revision } from '@review/core';
import { reviewId, reviewStatusSchema, revisionSchema } from '@review/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './client.ts';
import { narrowUnion } from './narrow.ts';

function toReview(row: typeof review.$inferSelect): Review {
  return {
    id: row.id,
    repoId: row.repoId,
    branch: row.branch,
    pinnedSha: row.pinnedSha,
    baseRef: row.baseRef,
    prNumber: row.prNumber,
    attachedPath: row.attachedPath,
    currentRevision: narrowUnion(row.currentRevision, revisionSchema.options, 'review.current_revision'),
    lastSeenPrSha: row.lastSeenPrSha,
    status: narrowUnion(row.status, reviewStatusSchema.options, 'review.status'),
    createdAt: row.createdAt,
  };
}

export type CreateReviewInput = {
  readonly repoId: string;
  /** Exactly one of `branch` / `pinnedSha` identifies a fresh review (§4). */
  readonly branch: string | null;
  readonly pinnedSha: string | null;
  readonly baseRef: string;
  readonly prNumber?: number | null;
};

export async function createReview(db: Db, input: CreateReviewInput): Promise<Review> {
  const id = reviewId();
  const rows = await db
    .insert(review)
    .values({
      id,
      repoId: input.repoId,
      branch: input.branch,
      pinnedSha: input.pinnedSha,
      baseRef: input.baseRef,
      prNumber: input.prNumber ?? null,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('createReview: insert returned no row');
  return toReview(row);
}

export async function getReview(db: Db, id: string): Promise<Review | null> {
  const rows = await db.select().from(review).where(eq(review.id, id)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toReview(row);
}

export async function listReviews(db: Db, filter?: { readonly repoId?: string }): Promise<Review[]> {
  const rows =
    filter?.repoId === undefined
      ? await db.select().from(review)
      : await db.select().from(review).where(eq(review.repoId, filter.repoId));
  return rows.map(toReview);
}

/** Find an existing review by `(repo, branch)` so opening the same branch twice never makes a second review. */
export async function findReviewByBranch(db: Db, repoId: string, branch: string): Promise<Review | null> {
  const rows = await db
    .select()
    .from(review)
    .where(and(eq(review.repoId, repoId), eq(review.branch, branch)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toReview(row);
}

/** Find a detached `(repo, sha)` review that has not yet adopted a branch. */
export async function findReviewByPinnedSha(db: Db, repoId: string, sha: string): Promise<Review | null> {
  const rows = await db
    .select()
    .from(review)
    .where(and(eq(review.repoId, repoId), eq(review.pinnedSha, sha), isNull(review.branch)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toReview(row);
}

async function update(db: Db, id: string, set: Partial<typeof review.$inferInsert>): Promise<Review> {
  const rows = await db.update(review).set(set).where(eq(review.id, id)).returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`review ${id} not found`);
  return toReview(row);
}

export async function setCurrentRevision(db: Db, id: string, revision: Revision): Promise<Review> {
  return update(db, id, { currentRevision: revision });
}

export async function setAttachedPath(db: Db, id: string, attachedPath: string | null): Promise<Review> {
  return update(db, id, { attachedPath });
}

export async function setPrNumber(db: Db, id: string, prNumber: number | null): Promise<Review> {
  return update(db, id, { prNumber });
}

export async function setLastSeenPrSha(db: Db, id: string, lastSeenPrSha: string | null): Promise<Review> {
  return update(db, id, { lastSeenPrSha });
}

export async function setStatus(db: Db, id: string, status: ReviewStatus): Promise<Review> {
  return update(db, id, { status });
}

/**
 * Adopt a branch on a `(repo, sha)` review (§4): the review upgrades in
 * place, keeping every thread and viewed check. `branch` fills in,
 * `pinned_sha` clears.
 */
export async function adoptBranch(db: Db, id: string, branch: string): Promise<Review> {
  return update(db, id, { branch, pinnedSha: null });
}
