/**
 * Per-review roll-ups for Homebase rows (SPEC §1: "what's waiting on you —
 * no reading order yet, unviewed files, unresolved threads, agent runs in
 * flight"). Everything here is a DB aggregate — a handful of `GROUP BY
 * review_id` queries over the whole id set — so listing a hundred reviews
 * costs five statements, not a hundred engines. Anything that needs git
 * (files changed, divergence) is deliberately absent; see Homebase.tsx.
 */
import { agentRun, comment, fileViewed, readingOrder, thread } from '@review/core/db';
import type { ReviewSummary } from '@review/core';
import { and, count, countDistinct, eq, inArray, max } from 'drizzle-orm';
import type { Db } from './client.ts';

function maxOf(...values: ReadonlyArray<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

export async function summarizeReviews(db: Db, reviewIds: readonly string[]): Promise<ReviewSummary[]> {
  if (reviewIds.length === 0) return [];
  const ids = [...reviewIds];

  const [threadRows, commentRows, viewedRows, readingOrderRows, runRows] = await Promise.all([
    db
      .select({
        reviewId: thread.reviewId,
        status: thread.status,
        n: count(),
        latest: max(thread.createdAt),
      })
      .from(thread)
      .where(inArray(thread.reviewId, ids))
      .groupBy(thread.reviewId, thread.status),
    db
      .select({ reviewId: thread.reviewId, latest: max(comment.createdAt) })
      .from(comment)
      .innerJoin(thread, eq(comment.threadId, thread.id))
      .where(inArray(thread.reviewId, ids))
      .groupBy(thread.reviewId),
    db
      .select({
        reviewId: fileViewed.reviewId,
        // A path re-viewed at a new blob is one file, not two.
        n: countDistinct(fileViewed.path),
        latest: max(fileViewed.viewedAt),
      })
      .from(fileViewed)
      .where(inArray(fileViewed.reviewId, ids))
      .groupBy(fileViewed.reviewId),
    db
      .select({
        reviewId: readingOrder.reviewId,
        version: max(readingOrder.version),
        latest: max(readingOrder.createdAt),
      })
      .from(readingOrder)
      .where(inArray(readingOrder.reviewId, ids))
      .groupBy(readingOrder.reviewId),
    db
      .select({ reviewId: agentRun.reviewId, n: count() })
      .from(agentRun)
      .where(and(inArray(agentRun.reviewId, ids), inArray(agentRun.status, ['pending', 'running'])))
      .groupBy(agentRun.reviewId),
  ]);

  const byId = new Map<string, ReviewSummary>(
    ids.map((reviewId) => [
      reviewId,
      {
        reviewId,
        openThreads: 0,
        resolvedThreads: 0,
        viewedFiles: 0,
        readingOrderVersion: null,
        agentRunning: false,
        lastActivityAt: null,
      },
    ]),
  );
  const touch = (reviewId: string, at: number | null): void => {
    const s = byId.get(reviewId);
    if (s !== undefined) s.lastActivityAt = maxOf(s.lastActivityAt, at);
  };

  for (const row of threadRows) {
    const s = byId.get(row.reviewId);
    if (s === undefined) continue;
    if (row.status === 'resolved') s.resolvedThreads += row.n;
    else s.openThreads += row.n;
    touch(row.reviewId, row.latest);
  }
  for (const row of commentRows) touch(row.reviewId, row.latest);
  for (const row of viewedRows) {
    const s = byId.get(row.reviewId);
    if (s === undefined) continue;
    s.viewedFiles = row.n;
    touch(row.reviewId, row.latest);
  }
  for (const row of readingOrderRows) {
    const s = byId.get(row.reviewId);
    if (s === undefined) continue;
    s.readingOrderVersion = row.version;
    touch(row.reviewId, row.latest);
  }
  for (const row of runRows) {
    const s = byId.get(row.reviewId);
    if (s !== undefined) s.agentRunning = row.n > 0;
  }

  return [...byId.values()];
}
