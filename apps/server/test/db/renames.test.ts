import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { createReview } from '../../src/db/reviews.ts';
import { createThread, listThreadsByReview } from '../../src/db/threads.ts';
import { listViewed, markViewed } from '../../src/db/fileViewed.ts';
import { renamePaths } from '../../src/db/renames.ts';

describe('renamePaths (§6): rewrites thread.path and file_viewed.path atomically', () => {
  test('both are rewritten together', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/rename-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, {
        repoId: repo.id,
        branch: 'feat/rename',
        pinnedSha: null,
        baseRef: 'main',
      });

      const thread = await createThread(db, {
        reviewId: review.id,
        path: 'old/name.ts',
        side: 'new',
        startLine: 1,
        endLine: 2,
        anchorBlobSha: 'blob1',
        anchorContextHash: 'ctx1',
        anchorContext: 'code',
        bodyMd: 'comment on the old path',
      });
      await markViewed(db, review.id, 'old/name.ts', 'blob1');

      await renamePaths(db, review.id, [{ from: 'old/name.ts', to: 'new/name.ts' }]);

      const threads = await listThreadsByReview(db, review.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(thread.id);
      expect(threads[0]?.path).toBe('new/name.ts');

      const viewed = await listViewed(db, review.id);
      expect(viewed).toHaveLength(1);
      expect(viewed[0]?.path).toBe('new/name.ts');
      expect(viewed[0]?.blobSha).toBe('blob1');
    } finally {
      await close();
    }
  });

  test('a no-op rename list touches nothing', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/rename-repo-2',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, {
        repoId: repo.id,
        branch: 'feat/rename2',
        pinnedSha: null,
        baseRef: 'main',
      });
      await markViewed(db, review.id, 'a.ts', 'blob1');
      await renamePaths(db, review.id, []);
      const viewed = await listViewed(db, review.id);
      expect(viewed[0]?.path).toBe('a.ts');
    } finally {
      await close();
    }
  });
});
