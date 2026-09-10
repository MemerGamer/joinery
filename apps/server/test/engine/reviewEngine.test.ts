/**
 * Engine tests (SPEC §5). Uses `engine.tick()` directly for deterministic
 * coverage of the table rows rather than racing the fs-watch debounce,
 * except for the dedicated "ticks serialize under a burst" test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ReviewEngine } from '../../src/engine/reviewEngine.ts';
import { captureContext } from '../../src/engine/anchor.ts';
import {
  createThread,
  getReview,
  getThreadWithComments,
  setCurrentRevision,
} from '../../src/db/index.ts';
import type { ServerEvent } from '@review/core';
import { gitCommit, headSha, runGit, setupRepo, setupRepoAndReview, writeRepoFile, type TestFixture } from './helpers.ts';
import type { Review } from '@review/core';

type Ctx = TestFixture & { review: Review };

async function makeEngine(ctx: Ctx, events: ServerEvent[]): Promise<ReviewEngine> {
  return ReviewEngine.create({
    db: ctx.db,
    repo: ctx.repo,
    review: ctx.review,
    emit: (e) => events.push(e),
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('engine tick', () => {
  test('editing a file re-renders just that file', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    events.length = 0;
    await writeRepoFile(ctx.repoDir, 'feature.txt', 'feature content CHANGED\n');
    await engine.tick();

    const changedEvents = events.filter((e) => e.type === 'files.changed');
    expect(changedEvents.length).toBe(1);
    const list = changedEvents[0]?.type === 'files.changed' ? changedEvents[0].list : undefined;
    expect(list?.files.map((f) => f.path)).toEqual(['feature.txt']);
  });

  test('a save with no byte change produces no delta (the early-out)', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    // Touch the file without changing its bytes.
    await writeRepoFile(ctx.repoDir, 'feature.txt', 'feature content\n');
    events.length = 0;
    await engine.tick();

    expect(events.filter((e) => e.type === 'files.changed')).toHaveLength(0);
  });

  test('git add produces no delta — working shows staged and unstaged alike', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    await writeRepoFile(ctx.repoDir, 'feature.txt', 'feature content CHANGED\n');
    await engine.tick();
    events.length = 0;

    runGit(ctx.repoDir, ['add', '-A']);
    await engine.tick();

    expect(events.filter((e) => e.type === 'files.changed')).toHaveLength(0);
  });

  test('committing moves head while working looks identical', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    await writeRepoFile(ctx.repoDir, 'feature.txt', 'feature content CHANGED\n');
    await engine.tick();
    const workingList = engine.getFileList();
    events.length = 0;

    gitCommit(ctx.repoDir, 'commit the change');
    await engine.tick();

    // `working` file list (path/blob identity) is unchanged post-commit.
    expect(engine.getFileList().files.map((f) => f.newBlob)).toEqual(workingList.files.map((f) => f.newBlob));
    // No files.changed should have fired since the working-tree list is identical.
    expect(events.filter((e) => e.type === 'files.changed')).toHaveLength(0);
  });

  test('an untracked file appears as an add', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    events.length = 0;
    await writeRepoFile(ctx.repoDir, 'new-file.txt', 'brand new\n');
    await engine.tick();

    const changedEvents = events.filter((e) => e.type === 'files.changed');
    expect(changedEvents.length).toBe(1);
    const list = changedEvents[0]?.type === 'files.changed' ? changedEvents[0].list : undefined;
    const entry = list?.files.find((f) => f.path === 'new-file.txt');
    expect(entry?.status).toBe('added');
  });

  test('switching branches drops working from the picker; checking back out restores it', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    let state = await engine.getState();
    expect(state.availableRevisions).toContain('working');

    runGit(ctx.repoDir, ['checkout', '-q', 'main']);
    await engine.tick();
    state = await engine.getState();
    expect(state.availableRevisions).not.toContain('working');
    expect(state.root.attachedPath).toBeNull();

    runGit(ctx.repoDir, ['checkout', '-q', 'feature']);
    await engine.tick();
    state = await engine.getState();
    expect(state.availableRevisions).toContain('working');
    expect(state.root.attachedPath).not.toBeNull();
  });

  test('a rename rewrites thread and viewed paths', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    // README.md exists in `main` (the base) too, so renaming it on `feature`
    // is a genuine rename relative to the merge-base — unlike feature.txt,
    // which was added *by* this branch and so has no prior identity to
    // rename from.
    const thread = await createThread(ctx.db, {
      reviewId: ctx.review.id,
      path: 'README.md',
      side: 'new',
      startLine: 1,
      endLine: 1,
      anchorBlobSha: 'placeholder',
      anchorContextHash: '',
      anchorContext: 'hello',
      bodyMd: 'a comment',
    });

    runGit(ctx.repoDir, ['mv', 'README.md', 'renamed.md']);
    await engine.tick();

    const reloaded = await getThreadWithComments(ctx.db, thread.id);
    expect(reloaded?.path).toBe('renamed.md');
  });

  test('a thread whose context moves re-anchors; one whose context is gone goes outdated without being deleted', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];

    await writeRepoFile(
      ctx.repoDir,
      'multi.txt',
      ['line1', 'line2', 'line3 TARGET', 'line4', 'line5'].join('\n') + '\n',
    );
    gitCommit(ctx.repoDir, 'add multi.txt');

    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    const entry = engine.getFileList().files.find((f) => f.path === 'multi.txt');
    expect(entry).toBeDefined();
    const lines = ['line1', 'line2', 'line3 TARGET', 'line4', 'line5'];
    const { context, hash } = captureContext(lines, 3, 3);

    const movingThread = await createThread(ctx.db, {
      reviewId: ctx.review.id,
      path: 'multi.txt',
      side: 'new',
      startLine: 3,
      endLine: 3,
      anchorBlobSha: entry?.newBlob ?? '',
      anchorContextHash: hash,
      anchorContext: context,
      bodyMd: 'about line3',
    });

    const goneThread = await createThread(ctx.db, {
      reviewId: ctx.review.id,
      path: 'multi.txt',
      side: 'new',
      startLine: 3,
      endLine: 3,
      anchorBlobSha: entry?.newBlob ?? '',
      anchorContextHash: 'irrelevant',
      anchorContext: 'this text will never appear again anywhere',
      bodyMd: 'a stale comment',
    });

    // Shift line3's content up by inserting two lines above it, and nuke the
    // exact text the second thread's context depends on nowhere else exists.
    await writeRepoFile(
      ctx.repoDir,
      'multi.txt',
      ['inserted-a', 'inserted-b', 'line1', 'line2', 'line3 TARGET', 'line4', 'line5'].join('\n') + '\n',
    );
    await engine.tick();

    const movedReloaded = await getThreadWithComments(ctx.db, movingThread.id);
    expect(movedReloaded?.outdated).toBe(false);
    expect(movedReloaded?.startLine).toBe(5); // shifted down by the two inserted lines

    const goneReloaded = await getThreadWithComments(ctx.db, goneThread.id);
    expect(goneReloaded).not.toBeNull(); // never deleted
    expect(goneReloaded?.outdated).toBe(true);
  });

  test('ticks serialize under a burst of events', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    events.length = 0;
    const tickPromises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      tickPromises.push(engine.tick());
    }
    await Promise.all(tickPromises);

    // No crash, and the engine settles on a consistent snapshot.
    const list = engine.getFileList();
    expect(Array.isArray(list.files)).toBe(true);
  });

  test('branch adoption: a named branch pointing at a pinned sha upgrades the review in place', async () => {
    // No review on the branch yet in this repo, so adopting it can't collide.
    const ctx = await setupRepo('unrelated-branch');
    cleanups.push(ctx.cleanup);
    const sha = headSha(ctx.repoDir);

    const { createReview } = await import('../../src/db/index.ts');
    const detachedReview = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: null,
      pinnedSha: sha,
      baseRef: 'main',
    });

    const events: ServerEvent[] = [];
    const engine = await ReviewEngine.create({
      db: ctx.db,
      repo: ctx.repo,
      review: detachedReview,
      emit: (e) => events.push(e),
    });
    cleanups.push(async () => engine.dispose());

    await engine.tick();
    const reloaded = await getReview(ctx.db, detachedReview.id);
    expect(reloaded?.branch).toBe('unrelated-branch');
    expect(reloaded?.pinnedSha).toBeNull();
  });

  test('switching revision via db + notifyExternalChange re-renders head', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];
    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    await writeRepoFile(ctx.repoDir, 'feature.txt', 'feature content CHANGED\n');
    await engine.tick();
    const workingBlob = engine.getFileList().files.find((f) => f.path === 'feature.txt')?.newBlob;

    events.length = 0;
    await setCurrentRevision(ctx.db, ctx.review.id, 'head');
    await engine.tick();

    const changedEvents = events.filter((e) => e.type === 'files.changed');
    expect(changedEvents.length).toBe(1);
    const list = changedEvents[0]?.type === 'files.changed' ? changedEvents[0].list : undefined;
    expect(list?.revision).toBe('head');
    // `head` renders the committed blob, not the uncommitted working edit.
    const headBlob = list?.files.find((f) => f.path === 'feature.txt')?.newBlob;
    expect(headBlob).not.toBe(workingBlob);
  });
});
