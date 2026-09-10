import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { adoptBranch, createReview, findReviewByBranch, getReview } from '../../src/db/reviews.ts';
import { createThread, listThreadsByReview } from '../../src/db/threads.ts';
import { listViewed, markViewed } from '../../src/db/fileViewed.ts';

describe('branch adoption (§4)', () => {
  test('a (repo, sha) review adopts a branch in place, keeping threads and viewed checks', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/some-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });

      const review = await createReview(db, {
        repoId: repo.id,
        branch: null,
        pinnedSha: 'deadbeef',
        baseRef: 'main',
      });
      expect(review.branch).toBeNull();
      expect(review.pinnedSha).toBe('deadbeef');

      const thread = await createThread(db, {
        reviewId: review.id,
        path: 'src/a.ts',
        side: 'new',
        startLine: 1,
        endLine: 1,
        anchorBlobSha: 'blob1',
        anchorContextHash: 'ctx1',
        anchorContext: 'const a = 1;',
        bodyMd: 'why is this here?',
      });

      await markViewed(db, review.id, 'src/b.ts', 'blob2');

      const adopted = await adoptBranch(db, review.id, 'feat/x');
      expect(adopted.branch).toBe('feat/x');
      expect(adopted.pinnedSha).toBeNull();
      expect(adopted.id).toBe(review.id);

      // Same review id — nothing was recreated.
      const refetched = await getReview(db, review.id);
      expect(refetched?.branch).toBe('feat/x');
      expect(refetched?.pinnedSha).toBeNull();

      // Threads survive, unmoved.
      const threads = await listThreadsByReview(db, review.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(thread.id);
      expect(threads[0]?.comments).toHaveLength(1);

      // Viewed checks survive.
      const viewed = await listViewed(db, review.id);
      expect(viewed).toHaveLength(1);
      expect(viewed[0]?.path).toBe('src/b.ts');

      // And opening the same branch again finds the very same review.
      const found = await findReviewByBranch(db, repo.id, 'feat/x');
      expect(found?.id).toBe(review.id);
    } finally {
      await close();
    }
  });

  test('opening the same branch twice never creates a second review', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/some-other-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });

      const first = await createReview(db, {
        repoId: repo.id,
        branch: 'feat/y',
        pinnedSha: null,
        baseRef: 'main',
      });

      const found = await findReviewByBranch(db, repo.id, 'feat/y');
      expect(found?.id).toBe(first.id);
    } finally {
      await close();
    }
  });
});
