import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { createReview } from '../../src/db/reviews.ts';
import { getReadingOrder, writeReadingOrderPlan } from '../../src/db/readingOrder.ts';
import { readingOrder } from '@joinery/core/db';
import { eq } from 'drizzle-orm';

describe('reading order replacement', () => {
  test('regenerating replaces the old reading order', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/ro-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, {
        repoId: repo.id,
        branch: 'feat/ro',
        pinnedSha: null,
        baseRef: 'main',
      });

      const v1 = await writeReadingOrderPlan(db, review.id, {
        steps: [{ title: 'Step one', guidance: '', attention: null, files: [{ path: 'a.ts', note: null }] }],
      });

      const v2 = await writeReadingOrderPlan(db, review.id, {
        steps: [
          { title: 'Step one', guidance: '', attention: null, files: [{ path: 'a.ts', note: null }] },
          { title: 'Step two', guidance: '', attention: null, files: [{ path: 'b.ts', note: 'new file' }] },
        ],
      });
      expect(v2.id).not.toBe(v1.id);

      // The review's reading order is v2, fully assembled.
      const latest = await getReadingOrder(db, review.id, ['a.ts', 'b.ts']);
      expect(latest?.id).toBe(v2.id);
      expect(latest?.steps).toHaveLength(2);
      expect(latest?.steps[1]?.files[0]?.path).toBe('b.ts');
      expect(latest?.unassignedPaths).toEqual([]);

      // Files present but assigned to no step surface as unassigned.
      const withExtra = await getReadingOrder(db, review.id, ['a.ts', 'b.ts', 'c.ts']);
      expect(withExtra?.unassignedPaths).toEqual(['c.ts']);

      // v1's row is deleted by regenerating, leaving exactly one.
      const rows = await db.select().from(readingOrder).where(eq(readingOrder.reviewId, review.id));
      expect(rows.map((r) => r.id)).toEqual([v2.id]);
    } finally {
      await close();
    }
  });
});
