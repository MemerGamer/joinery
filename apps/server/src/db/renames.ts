/**
 * Renames: `thread.path` and `file_viewed.path` are path-keyed, so a
 * `git diff -M` rename entry orphans both unless they are rewritten in the
 * same transaction that applies the new file list.
 */
import { fileViewed, thread } from '@joinery/core/db';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.ts';

export type Rename = {
  readonly from: string;
  readonly to: string;
};

/**
 * Rewrite `thread.path` and `file_viewed.path` for every rename in
 * `renames`, atomically. Call this from within the same transaction that
 * applies the file list, so the two never observe each other's paths as
 * stale.
 */
export async function renamePaths(db: Db, reviewId: string, renames: readonly Rename[]): Promise<void> {
  if (renames.length === 0) return;
  await db.transaction((tx) => {
    for (const { from, to } of renames) {
      tx.update(thread)
        .set({ path: to })
        .where(and(eq(thread.reviewId, reviewId), eq(thread.path, from)))
        .run();
      tx.update(fileViewed)
        .set({ path: to })
        .where(and(eq(fileViewed.reviewId, reviewId), eq(fileViewed.path, from)))
        .run();
    }
  });
}
