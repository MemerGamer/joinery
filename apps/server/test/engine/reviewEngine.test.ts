/**
 * Engine tests. Uses `engine.tick()` directly for deterministic
 * coverage of the table rows rather than racing the fs-watch debounce,
 * except for the dedicated "ticks serialize under a burst" test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ReviewEngine } from '../../src/engine/reviewEngine.ts';
import { captureContext } from '../../src/engine/anchor.ts';
import {
  appendReply,
  createReview,
  createThread,
  getReview,
  getThreadWithComments,
  setCurrentRevision,
} from '../../src/db/index.ts';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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
    expect(engine.getFileList('working').files.map((f) => f.newBlob)).toEqual(
      workingList.files.map((f) => f.newBlob),
    );
    // `working`'s list is identical, so it fires no event — but `head` is
    // kept warm proactively too ("head updates" on commit),
    // and it genuinely changed (headSha moved), so it does.
    const changed = events.filter((e) => e.type === 'files.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.type === 'files.changed' ? changed[0].list.revision : undefined).toBe('head');
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

  test('an attached review with no stored choice defaults to working', async () => {
    const ctx = await setupRepo('feature');
    cleanups.push(ctx.cleanup);
    const review = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'feature',
      pinnedSha: null,
      baseRef: 'main',
    });
    expect(review.currentRevision).toBeNull();

    const events: ServerEvent[] = [];
    const engine = await makeEngine({ ...ctx, review }, events);
    cleanups.push(async () => engine.dispose());

    const state = await engine.getState();
    expect(state.currentRevision).toBe('working');
  });

  test('a review whose branch is checked out nowhere defaults to head', async () => {
    const ctx = await setupRepo('feature');
    cleanups.push(ctx.cleanup);
    runGit(ctx.repoDir, ['checkout', '-q', 'main']);
    const review = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'feature',
      pinnedSha: null,
      baseRef: 'main',
    });
    expect(review.currentRevision).toBeNull();

    const events: ServerEvent[] = [];
    const engine = await makeEngine({ ...ctx, review }, events);
    cleanups.push(async () => engine.dispose());

    const state = await engine.getState();
    expect(state.currentRevision).toBe('head');
    expect(state.root.attachedPath).toBeNull();
  });

  test('an explicit "head" choice on an attached review does not flip to working', async () => {
    const ctx = await setupRepo('feature');
    cleanups.push(ctx.cleanup);
    const created = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'feature',
      pinnedSha: null,
      baseRef: 'main',
    });
    const review = await setCurrentRevision(ctx.db, created.id, 'head');

    const events: ServerEvent[] = [];
    const engine = await makeEngine({ ...ctx, review }, events);
    cleanups.push(async () => engine.dispose());

    const state = await engine.getState();
    expect(state.currentRevision).toBe('head');
    expect(state.root.attachedPath).not.toBeNull();
  });

  test('an explicit "working" choice survives detach/reattach without being overwritten', async () => {
    const ctx = await setupRepo('feature');
    cleanups.push(ctx.cleanup);
    const created = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'feature',
      pinnedSha: null,
      baseRef: 'main',
    });
    const review = await setCurrentRevision(ctx.db, created.id, 'working');

    const events: ServerEvent[] = [];
    const engine = await makeEngine({ ...ctx, review }, events);
    cleanups.push(async () => engine.dispose());

    let state = await engine.getState();
    expect(state.currentRevision).toBe('working');

    runGit(ctx.repoDir, ['checkout', '-q', 'main']);
    await engine.tick();
    state = await engine.getState();
    expect(state.currentRevision).toBe('head');
    expect(state.root.attachedPath).toBeNull();

    // The stored choice was never overwritten by the fallback, so checking
    // the branch back out restores it without any new explicit choice.
    const stillStored = await getReview(ctx.db, review.id);
    expect(stillStored?.currentRevision).toBe('working');

    runGit(ctx.repoDir, ['checkout', '-q', 'feature']);
    await engine.tick();
    state = await engine.getState();
    expect(state.currentRevision).toBe('working');
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

  test('a commit that rewrites the anchored lines marks the thread outdated, keeping it and all its comments', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];

    const lines = ['line1', 'line2', 'line3 TARGET', 'line4', 'line5'];
    await writeRepoFile(ctx.repoDir, 'edited.txt', lines.join('\n') + '\n');
    gitCommit(ctx.repoDir, 'add edited.txt');

    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    const entry = engine.getFileList().files.find((f) => f.path === 'edited.txt');
    expect(entry).toBeDefined();
    const { context, hash } = captureContext(lines, 3, 3);

    const editedThread = await createThread(ctx.db, {
      reviewId: ctx.review.id,
      path: 'edited.txt',
      side: 'new',
      startLine: 3,
      endLine: 3,
      anchorBlobSha: entry?.newBlob ?? '',
      anchorContextHash: hash,
      anchorContext: context,
      bodyMd: 'first comment',
    });
    await appendReply(ctx.db, { threadId: editedThread.id, author: 'user', bodyMd: 'a follow-up' });
    await appendReply(ctx.db, { threadId: editedThread.id, author: 'agent', bodyMd: 'an agent reply' });

    // Rewrite the exact anchored line (and its surrounding context), so the
    // captured context can no longer be found anywhere in the new file —
    // this must go `outdated`, not silently relocate to a wrong line.
    await writeRepoFile(
      ctx.repoDir,
      'edited.txt',
      ['line1', 'line2', 'line3 REWRITTEN', 'line4', 'line5'].join('\n') + '\n',
    );
    await engine.tick();

    const reloaded = await getThreadWithComments(ctx.db, editedThread.id);
    expect(reloaded).not.toBeNull(); // never deleted
    expect(reloaded?.outdated).toBe(true);
    expect(reloaded?.comments).toHaveLength(3); // original + two replies, all intact
    expect(reloaded?.comments.map((c) => c.bodyMd)).toEqual(['first comment', 'a follow-up', 'an agent reply']);
    // The stale line numbers and captured context are preserved for display
    // against "the code context captured when it was written",
    // not reset or blanked out.
    expect(reloaded?.startLine).toBe(3);
    expect(reloaded?.anchorContext).toBe(context);
  });

  test('the anchored file deleted entirely marks its thread outdated without deleting it', async () => {
    const ctx = await setupRepoAndReview();
    cleanups.push(ctx.cleanup);
    const events: ServerEvent[] = [];

    const lines = ['line1', 'line2', 'line3 TARGET', 'line4', 'line5'];
    await writeRepoFile(ctx.repoDir, 'doomed.txt', lines.join('\n') + '\n');
    gitCommit(ctx.repoDir, 'add doomed.txt');

    const engine = await makeEngine(ctx, events);
    cleanups.push(async () => engine.dispose());

    const entry = engine.getFileList().files.find((f) => f.path === 'doomed.txt');
    expect(entry).toBeDefined();
    const { context, hash } = captureContext(lines, 3, 3);

    const doomedThread = await createThread(ctx.db, {
      reviewId: ctx.review.id,
      path: 'doomed.txt',
      side: 'new',
      startLine: 3,
      endLine: 3,
      anchorBlobSha: entry?.newBlob ?? '',
      anchorContextHash: hash,
      anchorContext: context,
      bodyMd: 'about to be orphaned',
    });

    await rm(join(ctx.repoDir, 'doomed.txt'));
    await engine.tick();

    const reloaded = await getThreadWithComments(ctx.db, doomedThread.id);
    expect(reloaded).not.toBeNull(); // never deleted
    expect(reloaded?.outdated).toBe(true);
    expect(reloaded?.comments).toHaveLength(1);
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

  test('branch adoption: does not steal a branch already owned by another review, stays detached', async () => {
    const ctx = await setupRepo('feature');
    cleanups.push(ctx.cleanup);
    const sha = headSha(ctx.repoDir);

    // Another review already owns 'feature' in this repo.
    const owner = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'feature',
      pinnedSha: null,
      baseRef: 'main',
    });

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

    // create() already ticked once; tick again so a second attempt can't crash either.
    await engine.tick();

    const reloaded = await getReview(ctx.db, detachedReview.id);
    expect(reloaded?.branch).toBeNull();
    expect(reloaded?.pinnedSha).toBe(sha);

    const reloadedOwner = await getReview(ctx.db, owner.id);
    expect(reloadedOwner?.branch).toBe('feature');
  });

  test('branch adoption: skips a taken candidate branch and adopts the next unclaimed one', async () => {
    const ctx = await setupRepo('feature');
    cleanups.push(ctx.cleanup);
    const sha = headSha(ctx.repoDir);

    // Two more branches point at the same commit as 'feature'. `git branch
    // --contains` lists candidates alphabetically, so 'aaa-taken' sorts
    // before 'feature' and 'zzz-free' sorts after it.
    runGit(ctx.repoDir, ['branch', 'aaa-taken', sha]);
    runGit(ctx.repoDir, ['branch', 'zzz-free', sha]);

    const owner = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'aaa-taken',
      pinnedSha: null,
      baseRef: 'main',
    });
    // 'feature' is also a candidate (it's the branch the commit was made
    // on) and is taken too, so only 'zzz-free' is left unclaimed.
    const featureOwner = await createReview(ctx.db, {
      repoId: ctx.repo.id,
      branch: 'feature',
      pinnedSha: null,
      baseRef: 'main',
    });

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

    const reloaded = await getReview(ctx.db, detachedReview.id);
    expect(reloaded?.branch).toBe('zzz-free');
    expect(reloaded?.pinnedSha).toBeNull();

    const reloadedOwner = await getReview(ctx.db, owner.id);
    expect(reloadedOwner?.branch).toBe('aaa-taken');
    const reloadedFeatureOwner = await getReview(ctx.db, featureOwner.id);
    expect(reloadedFeatureOwner?.branch).toBe('feature');
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

    // A pure revision switch is not a live file change — it must never
    // surface as `files.changed` (that would stage a bogus "N files
    // updated" refresh prompt on the client for every switch). The caller
    // gets the new revision's list synchronously via `getFileList()`, the
    // same accessor the `POST /revision` route reads from.
    const changedEvents = events.filter((e) => e.type === 'files.changed');
    expect(changedEvents.length).toBe(0);

    const list = engine.getFileList();
    expect(list.revision).toBe('head');
    // `head` renders the committed blob, not the uncommitted working edit.
    const headBlob = list.files.find((f) => f.path === 'feature.txt')?.newBlob;
    expect(headBlob).not.toBe(workingBlob);
  });
});
