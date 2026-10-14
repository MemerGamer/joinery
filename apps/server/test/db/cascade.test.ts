import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { createReview } from '../../src/db/reviews.ts';
import { createThread, appendReply } from '../../src/db/threads.ts';
import { writeReadingOrderPlan } from '../../src/db/readingOrder.ts';
import { createRun, appendEvent } from '../../src/db/runs.ts';
import { review, thread, comment, readingOrder, step, stepFile, agentRun, agentEvent, repo } from '@joinery/core/db';
import { eq } from 'drizzle-orm';

describe('cascade deletes', () => {
  test('deleting a repo cascades through review, thread, comment, reading_order, step, step_file, agent_run, agent_event', async () => {
    const { db, close } = await setupTestDb();
    try {
      const r = await upsertRepo(db, {
        rootPath: '/tmp/cascade-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const rev = await createReview(db, { repoId: r.id, branch: 'feat/cascade', pinnedSha: null, baseRef: 'main' });

      const thr = await createThread(db, {
        reviewId: rev.id,
        path: 'a.ts',
        side: 'new',
        startLine: 1,
        endLine: 1,
        anchorBlobSha: 'b1',
        anchorContextHash: 'c1',
        anchorContext: 'x',
        body: 'first',
      });
      await appendReply(db, { threadId: thr.id, author: 'agent', body: 'reply' });

      await writeReadingOrderPlan(db, rev.id, {
        steps: [{ title: 'S', guidance: '', attention: null, files: [{ path: 'a.ts', note: null }] }],
      });

      const run = await createRun(db, { reviewId: rev.id, threadId: thr.id, kind: 'thread_reply' });
      await appendEvent(db, run.id, 'message', { hello: 'world' });

      // Sanity: everything is there before deletion.
      expect((await db.select().from(thread).where(eq(thread.reviewId, rev.id))).length).toBe(1);
      expect((await db.select().from(comment).where(eq(comment.threadId, thr.id))).length).toBe(2);
      expect((await db.select().from(readingOrder).where(eq(readingOrder.reviewId, rev.id))).length).toBe(1);
      expect((await db.select().from(agentRun).where(eq(agentRun.reviewId, rev.id))).length).toBe(1);
      expect((await db.select().from(agentEvent).where(eq(agentEvent.runId, run.id))).length).toBe(1);

      // Deleting the repo must cascade all the way down.
      await db.delete(repo).where(eq(repo.id, r.id));

      expect((await db.select().from(review).where(eq(review.id, rev.id))).length).toBe(0);
      expect((await db.select().from(thread).where(eq(thread.reviewId, rev.id))).length).toBe(0);
      expect((await db.select().from(comment).where(eq(comment.threadId, thr.id))).length).toBe(0);
      expect((await db.select().from(readingOrder).where(eq(readingOrder.reviewId, rev.id))).length).toBe(0);
      expect((await db.select().from(step)).length).toBe(0);
      expect((await db.select().from(stepFile)).length).toBe(0);
      expect((await db.select().from(agentRun).where(eq(agentRun.reviewId, rev.id))).length).toBe(0);
      expect((await db.select().from(agentEvent).where(eq(agentEvent.runId, run.id))).length).toBe(0);
    } finally {
      await close();
    }
  });
});
