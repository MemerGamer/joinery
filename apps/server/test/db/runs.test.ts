import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers.ts';
import { upsertRepo } from '../../src/db/repos.ts';
import { createReview } from '../../src/db/reviews.ts';
import { appendEvent, createRun, getRun, listEvents, setRunResumeCursor, setRunStatus } from '../../src/db/runs.ts';

describe('agent_run / agent_event (§9)', () => {
  test('event seq is monotonic and gapless under concurrent appends to one run', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/run-repo',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, { repoId: repo.id, branch: 'feat/run', pinnedSha: null, baseRef: 'main' });
      const run = await createRun(db, { reviewId: review.id, kind: 'reading_order' });

      const N = 25;
      await Promise.all(
        Array.from({ length: N }, (_, i) => appendEvent(db, run.id, 'message', { i })),
      );

      const events = await listEvents(db, run.id);
      expect(events).toHaveLength(N);
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i));
    } finally {
      await close();
    }
  });

  test('run status, session id, resume cursor, and replay round-trip', async () => {
    const { db, close } = await setupTestDb();
    try {
      const repo = await upsertRepo(db, {
        rootPath: '/tmp/run-repo-2',
        remoteOwner: null,
        remoteName: null,
        defaultBranch: 'main',
      });
      const review = await createReview(db, { repoId: repo.id, branch: 'feat/run2', pinnedSha: null, baseRef: 'main' });
      const run = await createRun(db, { reviewId: review.id, kind: 'thread_reply' });
      expect(run.status).toBe('pending');

      await setRunStatus(db, run.id, 'running');
      await setRunResumeCursor(db, run.id, { resume: true, resumeSessionAt: 'uuid-1', turnCount: 2 });
      await appendEvent(db, run.id, 'assistant', { text: 'hi' });
      await appendEvent(db, run.id, 'assistant', { text: 'there' });

      const done = await setRunStatus(db, run.id, 'done');
      expect(done.status).toBe('done');
      expect(done.endedAt).not.toBeNull();

      const fetched = await getRun(db, run.id);
      expect(fetched?.status).toBe('done');

      const events = await listEvents(db, run.id);
      expect(events.map((e) => e.payload)).toEqual([{ text: 'hi' }, { text: 'there' }]);
    } finally {
      await close();
    }
  });
});
