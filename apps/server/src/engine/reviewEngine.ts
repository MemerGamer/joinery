/**
 * One engine actor per review (SPEC §5).
 *
 * Owns the two mutable layers: root binding (§4) and the file list (§5). Runs
 * a serialized, debounced tick on any filesystem/git signal, ignoring event
 * payloads entirely — every signal means exactly one thing: run a tick.
 */
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Divergence,
  FileList,
  GitOperation,
  Review,
  ReviewState,
  Revision,
  Repo,
  RootBinding,
  ServerEvent,
  Thread,
} from '@review/core';
import { diffFileLists, isEmptyDelta, type FileListDelta } from '@review/core';
import {
  bytesToText,
  buildFileList,
  CatFile,
  detectInProgressOperation,
  divergence,
  getFileContents,
  git,
  gitCommonDir,
  gitOrThrow,
  mergeBase,
  revParse,
} from '../git/index.ts';
import {
  adoptBranch,
  getReview,
  getThreadWithComments,
  listThreadsByReview,
  renamePaths,
  updateAnchors,
  type Db,
  type Rename,
  type ThreadAnchorUpdate,
} from '../db/index.ts';
import { relocate } from './anchor.ts';
import { resolveRoot } from './root.ts';

const FOCUSED_POLL_MS = 15_000;
const BLURRED_POLL_MS = 120_000;
const DEBOUNCE_MS = 150;
const DEBOUNCE_CEILING_MS = 1_000;

export type ReviewEngineParams = {
  readonly db: Db;
  readonly repo: Repo;
  readonly review: Review;
  readonly emit: (event: ServerEvent) => void;
};

/** True when `child` is `parent` or nested under it (both already realpaths). */
function isUnderOrEqual(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSlash = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(withSlash);
}

export class ReviewEngine {
  readonly #db: Db;
  readonly #repo: Repo;
  #review: Review;
  readonly #emit: (event: ServerEvent) => void;
  readonly #catFile: CatFile;
  #gitCommonDir: string | null = null;

  #attachedPath: string | null = null;
  #detachedReason: RootBinding['detachedReason'] = 'not-checked-out';
  #operationInProgress: GitOperation | null = null;
  #snapshot: FileList;

  #rootWatcher: FSWatcher | null = null;
  #gitWatcher: FSWatcher | null = null;
  #watchedRoot: string | null = null;

  #ticking = false;
  #dirty = false;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #firstSignalAt: number | null = null;

  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #focused = false;
  #disposed = false;
  #subscriberCount = 0;

  private constructor(params: ReviewEngineParams) {
    this.#db = params.db;
    this.#repo = params.repo;
    this.#review = params.review;
    this.#emit = params.emit;
    this.#catFile = new CatFile(params.repo.rootPath);
    this.#snapshot = {
      reviewId: params.review.id,
      revision: params.review.currentRevision ?? 'head',
      baseSha: '',
      headSha: '',
      files: [],
    };
  }

  static async create(params: ReviewEngineParams): Promise<ReviewEngine> {
    const engine = new ReviewEngine(params);
    try {
      engine.#gitCommonDir = await gitCommonDir({ cwd: params.repo.rootPath });
    } catch {
      engine.#gitCommonDir = null;
    }
    await engine.tick();
    return engine;
  }

  get reviewId(): string {
    return this.#review.id;
  }

  getFileList(): FileList {
    return this.#snapshot;
  }

  async getState(): Promise<ReviewState> {
    return this.#computeState();
  }

  /**
   * The cwd/blobs backing the *current* snapshot, for per-file patch/content
   * fetches (SPEC §6). Scoped to the review's current revision — fetching a
   * different revision's patch for one file is a documented gap (see
   * IMPROVEMENTS.md).
   */
  getRenderContext(): { cwd: string; revision: Revision; baseSha: string; headSha: string } {
    return {
      cwd: this.#attachedPath ?? this.#repo.rootPath,
      revision: this.#snapshot.revision,
      baseSha: this.#snapshot.baseSha,
      headSha: this.#snapshot.headSha,
    };
  }

  getCatFile(): CatFile {
    return this.#catFile;
  }

  subscribe(): void {
    this.#subscriberCount++;
  }

  unsubscribe(): void {
    this.#subscriberCount = Math.max(0, this.#subscriberCount - 1);
  }

  get subscriberCount(): number {
    return this.#subscriberCount;
  }

  focus(): void {
    this.#focused = true;
    this.#restartPoll();
    this.#scheduleTick();
  }

  blur(): void {
    this.#focused = false;
    this.#restartPoll();
  }

  /** Call after any HTTP-side mutation that should be reflected promptly (e.g. revision switch). */
  notifyExternalChange(): void {
    this.#scheduleTick();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rootWatcher?.close();
    this.#gitWatcher?.close();
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    this.#catFile.close();
  }

  // --- signal handling / debounce ---

  #onSignal = (): void => {
    this.#scheduleTick();
  };

  #scheduleTick(): void {
    if (this.#disposed) return;
    const now = Date.now();
    this.#firstSignalAt ??= now;
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    const elapsed = now - this.#firstSignalAt;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, DEBOUNCE_CEILING_MS - elapsed));
    this.#debounceTimer = setTimeout(() => {
      this.#firstSignalAt = null;
      this.#debounceTimer = null;
      void this.tick();
    }, wait);
  }

  /**
   * Run a tick now, serialized against any tick already in flight: an event
   * mid-tick sets a dirty flag scheduling exactly one more rather than
   * overlapping. Public so callers (tests, an explicit "refresh" route) can
   * force a synchronous recompute instead of waiting on the debounce.
   */
  async tick(): Promise<void> {
    if (this.#disposed) return;
    if (this.#ticking) {
      this.#dirty = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#dirty = false;
        await this.#tickOnce();
      } while (this.#dirty && !this.#disposed);
    } finally {
      this.#ticking = false;
    }
  }

  // --- watchers ---

  #syncWatchers(attachedPath: string | null): void {
    if (attachedPath !== this.#watchedRoot) {
      this.#rootWatcher?.close();
      this.#rootWatcher = null;
      if (attachedPath !== null) {
        try {
          this.#rootWatcher = watch(attachedPath, { recursive: true }, this.#onSignal);
        } catch {
          this.#rootWatcher = null;
        }
      }
      this.#watchedRoot = attachedPath;
    }
    this.#syncGitWatcher();
  }

  /** Collapses into the root watch when the attached root is the main clone (SPEC §5). */
  #syncGitWatcher(): void {
    const gitDir = this.#gitCommonDir;
    const collapsed = gitDir !== null && this.#watchedRoot !== null && isUnderOrEqual(gitDir, this.#watchedRoot);
    const shouldWatch = gitDir !== null && !collapsed;

    if (shouldWatch === (this.#gitWatcher !== null)) return;
    this.#gitWatcher?.close();
    this.#gitWatcher = null;
    if (shouldWatch && gitDir !== null) {
      try {
        this.#gitWatcher = watch(gitDir, { recursive: true }, this.#onSignal);
      } catch {
        this.#gitWatcher = null;
      }
    }
  }

  // --- remote poll ---

  #restartPoll(): void {
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    if (this.#disposed) return;
    const interval = this.#focused ? FOCUSED_POLL_MS : BLURRED_POLL_MS;
    this.#pollTimer = setInterval(() => {
      void this.#remotePoll();
    }, interval);
  }

  /**
   * `git fetch --no-write-fetch-head` for the PR ref and
   * `refs/remotes/origin/<default>` — the second is not optional (SPEC §5):
   * without it the base never advances and the diff silently drifts.
   */
  async #remotePoll(): Promise<void> {
    if (this.#disposed) return;
    const review = this.#review;
    const cwd = this.#attachedPath ?? this.#repo.rootPath;
    const defaultBranchName = this.#repo.defaultBranch;
    let moved = false;
    try {
      const beforeDefault = await revParse(`refs/remotes/origin/${defaultBranchName}`, { cwd });
      await git(
        [
          'fetch',
          '--no-write-fetch-head',
          'origin',
          `refs/heads/${defaultBranchName}:refs/remotes/origin/${defaultBranchName}`,
        ],
        { cwd },
      );
      const afterDefault = await revParse(`refs/remotes/origin/${defaultBranchName}`, { cwd });
      if (beforeDefault !== afterDefault) moved = true;

      if (review.prNumber !== null) {
        const prRef = `refs/review/pr/${review.id}`;
        const beforePr = await revParse(prRef, { cwd });
        await git(
          ['fetch', '--no-write-fetch-head', 'origin', `refs/pull/${String(review.prNumber)}/head:${prRef}`],
          { cwd },
        );
        const afterPr = await revParse(prRef, { cwd });
        if (beforePr !== afterPr) moved = true;
      }
    } catch {
      return;
    }
    if (moved) this.#scheduleTick();
  }

  // --- the tick (SPEC §5, "The tick") ---

  async #tickOnce(): Promise<void> {
    const reloaded = await getReview(this.#db, this.#review.id);
    if (reloaded === null) return; // review deleted; registry disposes separately
    this.#review = reloaded;

    await this.#maybeAdoptBranch();

    // 1. Re-run root resolution.
    const rootRes = await resolveRoot(this.#repo, this.#review);
    const rootChanged = rootRes.attachedPath !== this.#attachedPath;
    this.#attachedPath = rootRes.attachedPath;
    this.#detachedReason = rootRes.detachedReason;
    this.#syncWatchers(this.#attachedPath);

    const operation = this.#attachedPath === null ? null : await this.#detectOperation(this.#attachedPath);
    const operationChanged = operation !== this.#operationInProgress;
    this.#operationInProgress = operation;

    if (operation !== null) {
      // Mid-operation states (SPEC §5): hold the last good snapshot.
      if (rootChanged || operationChanged) await this.#emitState();
      return;
    }

    const review = this.#review;
    const effectiveRevision = this.#resolveEffectiveRevision();
    const cwd = this.#attachedPath ?? this.#repo.rootPath;

    let targetRef: string | undefined;
    if (effectiveRevision === 'head') {
      targetRef =
        this.#attachedPath !== null
          ? 'HEAD'
          : (review.branch !== null ? `refs/heads/${review.branch}` : (review.pinnedSha ?? undefined));
    } else if (effectiveRevision === 'pr') {
      targetRef = `refs/review/pr/${review.id}`;
    }

    if (effectiveRevision !== 'working' && targetRef === undefined) {
      if (rootChanged || operationChanged) await this.#emitState();
      return;
    }

    const headRef = effectiveRevision === 'working' ? 'HEAD' : (targetRef as string);

    // 2. Resolve the ref to a commit, once, before anything reads it.
    //
    // Everything downstream has to agree on a single commit even if the ref
    // moves mid-tick, and `headSha` is what a later tick compares against to
    // decide whether head actually moved — a ref *name* would always compare
    // equal to itself, so storing one silently disables that check.
    const headSha = await revParse(headRef, { cwd });
    if (headSha === null) {
      if (rootChanged || operationChanged) await this.#emitState();
      return;
    }

    // No merge base means `baseRef` is unknown to this repo (a deleted or
    // never-fetched branch): fall back to head, i.e. an empty diff, rather
    // than showing the whole history as changed.
    const baseSha = (await mergeBase(review.baseRef, headSha, { cwd })) ?? headSha;

    // 3. Build the file list (includes the one `hash-object` spawn for working).
    let newFiles;
    try {
      newFiles = await buildFileList(
        effectiveRevision === 'working'
          ? { cwd, revision: effectiveRevision, baseSha }
          : { cwd, revision: effectiveRevision, baseSha, targetSha: headSha },
      );
    } catch {
      // A git error mid-tick — hold the last good snapshot rather than crash the actor.
      if (rootChanged || operationChanged) await this.#emitState();
      return;
    }

    // 4. The early-out: list identical -> stop. Zero UI work.
    const delta = diffFileLists(this.#snapshot.files, newFiles);
    const revisionChanged = effectiveRevision !== this.#snapshot.revision;
    if (isEmptyDelta(delta) && !revisionChanged) {
      // The *files* are unchanged, but head may still have moved under them
      // (an amend, a rebase that preserved the tree). Per-file patch fetches
      // key off these shas, so keep them current even though there is nothing
      // for the client to redraw.
      this.#snapshot = { ...this.#snapshot, baseSha, headSha };
      if (rootChanged || operationChanged) await this.#emitState();
      return;
    }

    // 5. Push the difference.
    //
    // Renames are derived from *this build's* rename detection (git diff -M
    // against `baseSha`), not from `delta.renamed` — a file that was
    // unmodified relative to base was never in the previous snapshot at all,
    // so the client-facing delta has nothing to call a "rename" for it, but
    // a thread anchored to its old path still needs to follow (SPEC §6).
    const renames: Rename[] = [];
    for (const f of newFiles) {
      if (f.oldPath !== null) renames.push({ from: f.oldPath, to: f.path });
    }
    if (renames.length > 0) {
      await renamePaths(this.#db, review.id, renames);
    }
    await this.#reanchorThreads(delta, renames, effectiveRevision, cwd);

    this.#snapshot = {
      reviewId: review.id,
      revision: effectiveRevision,
      baseSha,
      headSha,
      files: newFiles,
    };

    this.#emit({ type: 'files.changed', reviewId: review.id, list: this.#snapshot });
    if (rootChanged || operationChanged) await this.#emitState();
  }

  /** SPEC §4: the first time a named branch's history contains a `(repo, sha)` review's pinned commit, adopt it. */
  async #maybeAdoptBranch(): Promise<void> {
    const review = this.#review;
    if (review.branch !== null || review.pinnedSha === null) return;
    const result = await git(['branch', '--format=%(refname:short)', '--contains', review.pinnedSha], {
      cwd: this.#repo.rootPath,
    });
    if (result.exitCode !== 0) return;
    const text = bytesToText(result.stdout).trim();
    if (text === '') return;
    const branchName = text.split('\n')[0]?.trim();
    if (branchName === undefined || branchName === '') return;
    this.#review = await adoptBranch(this.#db, review.id, branchName);
  }

  /**
   * SPEC §13.2 / §4 / §9: the stored choice always wins when present; falling
   * back for unavailability must never overwrite it, so a branch that goes
   * away and comes back restores the prior choice rather than adopting
   * whatever the fallback picked in the meantime.
   */
  #resolveEffectiveRevision(): Revision {
    const review = this.#review;
    const attached = this.#attachedPath !== null;
    const desired = review.currentRevision ?? (attached ? 'working' : 'head');
    if (desired === 'working' && !attached) return 'head';
    if (desired === 'pr' && review.prNumber === null) return 'head';
    return desired;
  }

  async #detectOperation(attachedPath: string): Promise<GitOperation | null> {
    try {
      const result = await gitOrThrow(['rev-parse', '--git-dir'], { cwd: attachedPath });
      const raw = bytesToText(result.stdout).trim();
      const gitDir = raw.startsWith('/') ? raw : resolve(attachedPath, raw);
      return await detectInProgressOperation(gitDir);
    } catch {
      return null;
    }
  }

  /**
   * Threads across snapshots (SPEC §5, §8). Exact match on `anchor_blob_sha`
   * is free and never reaches this function (nothing in `delta` mentions an
   * unchanged file). Otherwise search the new blob for the captured context:
   * hit updates line numbers, miss sets `outdated` and keeps the thread.
   */
  async #reanchorThreads(
    delta: FileListDelta,
    renames: readonly Rename[],
    revision: Revision,
    cwd: string,
  ): Promise<void> {
    const threads = await listThreadsByReview(this.#db, this.#review.id);
    if (threads.length === 0) return;

    const renamedFrom = new Set(renames.map((r) => r.from));
    const updates: ThreadAnchorUpdate[] = [];

    for (const removedEntry of delta.removed) {
      if (renamedFrom.has(removedEntry.path)) continue;
      for (const t of threads) {
        if (t.path === removedEntry.path && !t.outdated) {
          updates.push(outdatedUpdate(t));
        }
      }
    }

    for (const c of delta.changed) {
      const pathThreads = threads.filter((t) => t.path === c.after.path);
      if (pathThreads.length === 0) continue;

      let contents: { oldContents: string | null; newContents: string | null } | null;
      try {
        contents = await getFileContents({
          cwd,
          revision,
          path: c.after.path,
          oldBlob: c.after.oldBlob,
          newBlob: c.after.newBlob,
          catFile: this.#catFile,
        });
      } catch {
        contents = null;
      }

      for (const t of pathThreads) {
        const sideBlob = t.side === 'old' ? c.after.oldBlob : c.after.newBlob;
        if (sideBlob === t.anchorBlobSha) continue; // this thread's side didn't change — free

        const text = t.side === 'old' ? (contents?.oldContents ?? null) : (contents?.newContents ?? null);
        if (text === null) {
          updates.push(outdatedUpdate(t));
          continue;
        }

        const located = relocate(text.split('\n'), t);
        if (located === null) {
          updates.push(outdatedUpdate(t));
        } else {
          updates.push({
            id: t.id,
            startLine: located.startLine,
            endLine: located.endLine,
            anchorBlobSha: sideBlob,
            outdated: false,
            changedSinceComment: true,
          });
        }
      }
    }

    if (updates.length === 0) return;
    await updateAnchors(this.#db, updates);

    const ids = [...new Set(updates.map((u) => u.id))];
    const updatedThreads = (await Promise.all(ids.map((id) => getThreadWithComments(this.#db, id)))).filter(
      (t): t is Thread => t !== null,
    );
    if (updatedThreads.length > 0) {
      this.#emit({ type: 'thread.relocated', reviewId: this.#review.id, threads: updatedThreads });
    }
  }

  async #computeState(): Promise<ReviewState> {
    const review = this.#review;
    const available: Revision[] = [];
    if (this.#attachedPath !== null) available.push('working');
    available.push('head');
    if (review.prNumber !== null) available.push('pr');

    let divergenceValue: Divergence | null = null;
    let basesMismatched = false;
    if (review.prNumber !== null) {
      const cwd = this.#attachedPath ?? this.#repo.rootPath;
      const prRef = `refs/review/pr/${review.id}`;
      const headRef =
        this.#attachedPath !== null
          ? 'HEAD'
          : (review.branch !== null ? `refs/heads/${review.branch}` : (review.pinnedSha ?? 'HEAD'));
      try {
        divergenceValue = await divergence(headRef, prRef, { cwd });
        const baseHead = await mergeBase(review.baseRef, headRef, { cwd });
        const basePr = await mergeBase(review.baseRef, prRef, { cwd });
        basesMismatched = baseHead !== null && basePr !== null && baseHead !== basePr;
      } catch {
        divergenceValue = null;
      }
    }

    return {
      reviewId: review.id,
      availableRevisions: available,
      currentRevision: this.#resolveEffectiveRevision(),
      root: { attachedPath: this.#attachedPath, detachedReason: this.#detachedReason },
      divergence: divergenceValue,
      basesMismatched,
      operationInProgress: this.#operationInProgress,
      prNumber: review.prNumber,
    };
  }

  async #emitState(): Promise<void> {
    const state = await this.#computeState();
    this.#emit({ type: 'root.rebound', reviewId: this.#review.id, state });
  }
}

function outdatedUpdate(t: Thread): ThreadAnchorUpdate {
  return {
    id: t.id,
    startLine: t.startLine,
    endLine: t.endLine,
    anchorBlobSha: t.anchorBlobSha,
    outdated: true,
    changedSinceComment: true,
  };
}
