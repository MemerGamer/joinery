/**
 * `review` — one row per `(repo, branch)`. A detached review starts as
 * `(repo, pinned_sha)` with a null branch and adopts one later, in place.
 */
import { review } from '@joinery/core/db';
import type { Review, ReviewStatus, Revision } from '@joinery/core';
import { reviewId, reviewStatusSchema, revisionSchema } from '@joinery/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
    currentRevision:
      row.currentRevision === null
        ? null
        : narrowUnion(row.currentRevision, revisionSchema.options, 'review.current_revision'),
    lastSeenPrSha: row.lastSeenPrSha,
    status: narrowUnion(row.status, reviewStatusSchema.options, 'review.status'),
    createdAt: row.createdAt,
  };
}

export type CreateReviewInput = {
  readonly repoId: string;
  /** Exactly one of `branch` / `pinnedSha` identifies a fresh review. */
  readonly branch: string | null;
  readonly pinnedSha: string | null;
  readonly baseRef: string;
  readonly prNumber?: number | null;
  /** Status for the new row (drafts feature); defaults to `'open'`. */
  readonly status?: ReviewStatus;
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
      status: input.status ?? 'open',
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

export async function listReviews(
  db: Db,
  filter?: { readonly repoId?: string; readonly status?: ReviewStatus },
): Promise<Review[]> {
  const conditions = [];
  if (filter?.repoId !== undefined) conditions.push(eq(review.repoId, filter.repoId));
  if (filter?.status !== undefined) conditions.push(eq(review.status, filter.status));

  const rows =
    conditions.length === 0
      ? await db.select().from(review)
      : await db
          .select()
          .from(review)
          .where(conditions.length === 1 ? conditions[0] : and(...conditions));
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
 * Mark `id` as opened now: `GET /api/reviews/:id` calls this after
 * building its response, so "unread agent replies" is measured against the
 * *previous* open, not the one currently in flight. Bypasses the `update()`
 * helper above since `lastOpenedAt` is set to a raw `unixepoch()` SQL
 * expression rather than a plain value.
 */
export async function touchOpened(db: Db, id: string): Promise<Review> {
  const rows = await db
    .update(review)
    .set({ lastOpenedAt: sql`(unixepoch())` })
    .where(eq(review.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`review ${id} not found`);
  return toReview(row);
}

/**
 * Adopt a branch on a `(repo, sha)` review: the review upgrades in
 * place, keeping every thread and viewed check. `branch` fills in,
 * `pinned_sha` clears.
 */
export async function adoptBranch(db: Db, id: string, branch: string): Promise<Review> {
  return update(db, id, { branch, pinnedSha: null });
}
