/**
 * `file_viewed` — per-file "viewed" checks, keyed by `(review_id, path,
 * blob_sha)`. A changed blob simply fails to match and the check clears
 * itself; there is deliberately no invalidation code here.
 */
import { fileViewed } from '@joinery/core/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';

export type FileViewed = {
  readonly path: string;
  readonly blobSha: string;
  readonly viewedAt: number;
};

/** Mark `(reviewId, path, blobSha)` as viewed. Idempotent. */
export async function markViewed(db: Db, reviewId: string, path: string, blobSha: string): Promise<void> {
  await db
    .insert(fileViewed)
    .values({ reviewId, path, blobSha })
    .onConflictDoNothing();
}

/** Clear the viewed check for `(reviewId, path, blobSha)`, if present. */
export async function unmarkViewed(db: Db, reviewId: string, path: string, blobSha: string): Promise<void> {
  await db
    .delete(fileViewed)
    .where(and(eq(fileViewed.reviewId, reviewId), eq(fileViewed.path, path), eq(fileViewed.blobSha, blobSha)));
}

export async function listViewed(db: Db, reviewId: string): Promise<FileViewed[]> {
  const rows = await db.select().from(fileViewed).where(eq(fileViewed.reviewId, reviewId));
  return rows.map((row) => ({ path: row.path, blobSha: row.blobSha, viewedAt: row.viewedAt }));
}

/** Whether `(path, blobSha)` is currently marked viewed for `reviewId`. */
export async function isViewed(db: Db, reviewId: string, path: string, blobSha: string): Promise<boolean> {
  const rows = await db
    .select({ path: fileViewed.path })
    .from(fileViewed)
    .where(and(eq(fileViewed.reviewId, reviewId), eq(fileViewed.path, path), eq(fileViewed.blobSha, blobSha)))
    .limit(1);
  return rows.length > 0;
}

/**
 * `listViewed` for a whole batch of reviews at once (one query), so the
 * Homebase composer can recompute every review's `viewedFiles` against its
 * *current* file list without a query per review.
 */
export async function listViewedForReviews(
  db: Db,
  reviewIds: readonly string[],
): Promise<Map<string, FileViewed[]>> {
  const byReview = new Map<string, FileViewed[]>();
  if (reviewIds.length === 0) return byReview;

  const rows = await db.select().from(fileViewed).where(inArray(fileViewed.reviewId, [...reviewIds]));
  for (const row of rows) {
    const list = byReview.get(row.reviewId) ?? [];
    list.push({ path: row.path, blobSha: row.blobSha, viewedAt: row.viewedAt });
    byReview.set(row.reviewId, list);
  }
  return byReview;
}
