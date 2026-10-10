import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { createReview } from '../../src/db/reviews.ts';
import { isViewed, listViewed, markViewed } from '../../src/db/fileViewed.ts';

describe('file_viewed: keyed by blob SHA, no invalidation code', () => {
  test('a changed blob simply fails to match and the check clears itself', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/fv-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, {
        repoId: repo.id,
        branch: 'feat/fv',
        pinnedSha: null,
        baseRef: 'main',
      });

      await markViewed(db, review.id, 'src/a.ts', 'blobA1');
      expect(await isViewed(db, review.id, 'src/a.ts', 'blobA1')).toBe(true);

      // The blob changes (new content) — same path, new SHA. The old check
      // simply no longer matches; there is no invalidation to run.
      expect(await isViewed(db, review.id, 'src/a.ts', 'blobA2')).toBe(false);

      // Marking the new blob viewed adds a second row; the old one is left
      // alone (harmless — it just never matches again).
      await markViewed(db, review.id, 'src/a.ts', 'blobA2');
      const rows = await listViewed(db, review.id);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.blobSha).sort()).toEqual(['blobA1', 'blobA2']);
    } finally {
      await close();
    }
  });

  test('marking viewed twice for the same (review, path, blob) is idempotent', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/fv-repo-2',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, {
        repoId: repo.id,
        branch: 'feat/fv2',
        pinnedSha: null,
        baseRef: 'main',
      });

      await markViewed(db, review.id, 'src/a.ts', 'blob1');
      await markViewed(db, review.id, 'src/a.ts', 'blob1');
      const rows = await listViewed(db, review.id);
      expect(rows).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
