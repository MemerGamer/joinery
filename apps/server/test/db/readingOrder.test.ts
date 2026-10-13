import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { createReview } from '../../src/db/reviews.ts';
import { getLatestReadingOrder, writeReadingOrderPlan } from '../../src/db/readingOrder.ts';
import { readingOrder } from '@joinery/core/db';
import { eq } from 'drizzle-orm';

describe('reading order versioning', () => {
  test('regenerating writes a new version, retains the old one, and returns the newest', async () => {
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
        steps: [{ title: 'Step one', explanation_md: '', files: [{ path: 'a.ts', note_md: null }] }],
      });
      expect(v1.version).toBe(1);

      const v2 = await writeReadingOrderPlan(db, review.id, {
        steps: [
          { title: 'Step one', explanation_md: '', files: [{ path: 'a.ts', note_md: null }] },
          { title: 'Step two', explanation_md: '', files: [{ path: 'b.ts', note_md: 'new file' }] },
        ],
      });
      expect(v2.version).toBe(2);
      expect(v2.id).not.toBe(v1.id);

      // Latest returns v2, fully assembled.
      const latest = await getLatestReadingOrder(db, review.id, ['a.ts', 'b.ts']);
      expect(latest?.version).toBe(2);
      expect(latest?.steps).toHaveLength(2);
      expect(latest?.steps[1]?.files[0]?.path).toBe('b.ts');
      expect(latest?.unassignedPaths).toEqual([]);

      // Files present but assigned to no step surface as unassigned.
      const withExtra = await getLatestReadingOrder(db, review.id, ['a.ts', 'b.ts', 'c.ts']);
      expect(withExtra?.unassignedPaths).toEqual(['c.ts']);

      // v1's row is retained, not destroyed, by regenerating.
      const rows = await db.select().from(readingOrder).where(eq(readingOrder.reviewId, review.id));
      const versions = rows.map((r) => r.version).sort();
      expect(versions).toEqual([1, 2]);
      expect(rows.some((r) => r.id === v1.id)).toBe(true);
    } finally {
      await close();
    }
  });
});
