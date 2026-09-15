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
  findOpenPrNumberForBranch,
  getFileContents,
  git,
  gitCommonDir,
  gitOrThrow,
  mergeBase,
  revParse,
} from '../git/index.ts';
import {
  adoptBranch,
  findReviewByBranch,
  getReview,
  getThreadWithComments,
  listThreadsByReview,
  renamePaths,
  setPrNumber,
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
// PR discovery hits the GitHub API (via `gh`), not a local ref — polled far
// less often than the local remote-tracking fetch.
const PR_DETECT_POLL_MS = 300_000;

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
  /** One cached snapshot per revision — kept warm proactively so a revision switch is a cache read, not a recompute. */
  #snapshots: Record<Revision, FileList>;
  #built = new Set<Revision>();
  /**
   * The expensive, git-derived half of `ReviewState` — `divergence` and
   * `basesMismatched` — recomputed only inside the tick path (`#emitState`)
   * and reused by every `getState()` call in between. Every input to these
   * two fields (HEAD, the PR ref `refs/review/pr/<id>`, `baseRef`) only moves
   * via a detector signal that already schedules a tick, so a revision
   * *switch* (which does not go through the tick path) can never invalidate
   * this cache. `null` until the first computation, so `getState()` falls
   * back to computing it lazily rather than serving a placeholder.
   */
  #cachedRevisionState: Pick<ReviewState, 'divergence' | 'basesMismatched'> | null = null;
  /**
   * Which detector(s) fired since the last tick, so a tick only rebuilds the
   * revision(s) that detector actually invalidates rather than all three.
   * `remote-default` invalidates every revision's `baseSha` (shared
   * `merge-base(baseRef, ...)`), so it always forces a full rebuild.
   */
  #pendingSources = new Set<'root' | 'git' | 'remote-default' | 'remote-pr'>([
    'root',
    'git',
    'remote-default',
    'remote-pr',
  ]);

  #rootWatcher: FSWatcher | null = null;
  #gitWatcher: FSWatcher | null = null;
  #watchedRoot: string | null = null;

  #ticking = false;
  #dirty = false;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #firstSignalAt: number | null = null;

  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #lastPrCheckAt: number | null = null;
  #focused = false;
  #disposed = false;
  #subscriberCount = 0;

  private constructor(params: ReviewEngineParams) {
    this.#db = params.db;
    this.#repo = params.repo;
    this.#review = params.review;
    this.#emit = params.emit;
    this.#catFile = new CatFile(params.repo.rootPath);
    const placeholder = (revision: Revision): FileList => ({
      reviewId: params.review.id,
      revision,
      baseSha: '',
      headSha: '',
      files: [],
    });
    this.#snapshots = {
      working: placeholder('working'),
      head: placeholder('head'),
      pr: placeholder('pr'),
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

  /** The cached snapshot for `revision`, or the review's current revision when omitted. */
  getFileList(revision?: Revision): FileList {
    return this.#snapshots[revision ?? this.#resolveEffectiveRevision()];
  }

  /**
   * The cheap fields (`currentRevision`, `operationInProgress`, ...) are
   * always rebuilt fresh, since `setCurrentRevisionHint()` and the operation
   * detector can change them without a tick. The expensive git-derived
   * fields come from `#cachedRevisionState`, computed lazily here on first
   * access if no tick has populated it yet.
   */
  async getState(): Promise<ReviewState> {
    if (this.#cachedRevisionState === null) return this.#computeState();
    return this.#buildState();
  }

  /**
   * The cwd/blobs backing the *current* snapshot, for per-file patch/content
   * fetches (SPEC §6). Scoped to the review's current revision — fetching a
   * different revision's patch for one file is a documented gap (see
   * IMPROVEMENTS.md).
   */
  getRenderContext(): { cwd: string; revision: Revision; baseSha: string; headSha: string } {
    const snapshot = this.#snapshots[this.#resolveEffectiveRevision()];
    return {
      cwd: this.#attachedPath ?? this.#repo.rootPath,
      revision: snapshot.revision,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    };
  }

  /**
   * Updates the in-memory "current revision" immediately after an HTTP
   * switch, without waiting for a tick to reload the review row — the switch
   * itself already persisted it (routes.ts), and the target revision's
   * snapshot is already warm, so there is nothing left to recompute.
   */
  setCurrentRevisionHint(revision: Revision): void {
    this.#review = { ...this.#review, currentRevision: revision };
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

  /** Call after any HTTP-side mutation that should be reflected promptly. */
  notifyExternalChange(): void {
    this.#pendingSources.add('root');
    this.#pendingSources.add('git');
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

  #onRootSignal = (): void => {
    this.#pendingSources.add('root');
    this.#scheduleTick();
  };

  #onGitSignal = (): void => {
    this.#pendingSources.add('git');
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
          this.#rootWatcher = watch(attachedPath, { recursive: true }, this.#onRootSignal);
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
        this.#gitWatcher = watch(gitDir, { recursive: true }, this.#onGitSignal);
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
    let defaultMoved = false;
    let prMoved = false;
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
      if (beforeDefault !== afterDefault) defaultMoved = true;

      if (review.prNumber !== null) {
        const prRef = `refs/review/pr/${review.id}`;
        const beforePr = await revParse(prRef, { cwd });
        await git(
          ['fetch', '--no-write-fetch-head', 'origin', `refs/pull/${String(review.prNumber)}/head:${prRef}`],
          { cwd },
        );
        const afterPr = await revParse(prRef, { cwd });
        if (beforePr !== afterPr) prMoved = true;
      }
    } catch {
      return;
    }
    if (review.prNumber === null && review.branch !== null) {
      await this.#detectPr(review.branch, cwd);
    }
    // `defaultMoved` invalidates every revision's shared merge-base; `prMoved`
    // only invalidates the `pr` snapshot.
    if (defaultMoved) this.#pendingSources.add('remote-default');
    if (prMoved) this.#pendingSources.add('remote-pr');
    if (defaultMoved || prMoved) this.#scheduleTick();
  }

  /**
   * Discover a PR for `branch` via `gh` (SPEC §5, "Detectors") — checked at
   * most once per `PR_DETECT_POLL_MS`, and never again once found, since
   * `#remotePoll` only calls this while `review.prNumber` is still null.
   */
  async #detectPr(branch: string, cwd: string): Promise<void> {
    const now = Date.now();
    if (this.#lastPrCheckAt !== null && now - this.#lastPrCheckAt < PR_DETECT_POLL_MS) return;
    this.#lastPrCheckAt = now;
    const prNumber = await findOpenPrNumberForBranch(branch, { cwd });
    if (prNumber === null || this.#disposed) return;
    this.#review = await setPrNumber(this.#db, this.#review.id, prNumber);
    this.#pendingSources.add('remote-pr');
    this.#scheduleTick();
  }

  // --- the tick (SPEC §5, "The tick") ---

  async #tickOnce(): Promise<void> {
    const previousPrNumber = this.#review.prNumber;
    const reloaded = await getReview(this.#db, this.#review.id);
    if (reloaded === null) return; // review deleted; registry disposes separately
    this.#review = reloaded;
    // Newly discovered/changed independently of the file list (e.g. `#detectPr`)
    // — the early-outs below only skip `#emitState` for an unchanged file list,
    // and this must not get swallowed by them the same way root/operation don't.
    const prNumberChanged = reloaded.prNumber !== previousPrNumber;

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
      // Mid-operation states (SPEC §5): hold the last good snapshot. The
      // cached `divergence`/`basesMismatched` can still be stale though — a
      // commit or remote move that landed mid-operation still moved them —
      // so the same signal check as below applies here too, against the
      // signals accumulated so far (not yet snapshotted/cleared at this
      // point in the tick).
      if (rootChanged || operationChanged || prNumberChanged || this.#stateSignalsFired(this.#pendingSources)) {
        await this.#emitState();
      }
      return;
    }

    const review = this.#review;
    const effectiveRevision = this.#resolveEffectiveRevision();
    const cwd = this.#attachedPath ?? this.#repo.rootPath;
    const available = this.availableRevisions();

    // Snapshot and clear the accumulated signals for this tick. Anything that
    // arrives while this tick is running lands in a fresh set the *next* tick
    // reads — see the `#dirty` loop in `tick()`, which guarantees there is a
    // next tick whenever a signal arrives mid-run.
    const sources = new Set(this.#pendingSources);
    this.#pendingSources.clear();

    // 2-5, per revision: only the revision(s) an actual detector invalidated
    // get rebuilt — a worktree edit only touches `working`, a commit only
    // touches `head`, the PR ref moving only touches `pr`. `root` changing
    // (the attached directory itself moved or vanished) can change how every
    // revision resolves, so it forces all of them. `remote-default` moving
    // the base is the one case that must invalidate every revision even
    // though only one detector fired, because `merge-base(baseRef, ...)` is
    // shared across all three.
    for (const rev of available) {
      const needsRebuild =
        rootChanged ||
        !this.#built.has(rev) ||
        sources.has('remote-default') ||
        (rev === 'working' && sources.has('root')) ||
        (rev === 'head' && sources.has('git')) ||
        (rev === 'pr' && sources.has('remote-pr'));
      if (!needsRebuild) continue;

      let targetRef: string | undefined;
      if (rev === 'head') {
        targetRef =
          this.#attachedPath !== null
            ? 'HEAD'
            : (review.branch !== null ? `refs/heads/${review.branch}` : (review.pinnedSha ?? undefined));
      } else if (rev === 'pr') {
        targetRef = `refs/review/pr/${review.id}`;
      }
      if (rev !== 'working' && targetRef === undefined) continue;

      const headRef = rev === 'working' ? 'HEAD' : (targetRef as string);

      // Resolve the ref to a commit, once, before anything reads it.
      //
      // Everything downstream has to agree on a single commit even if the ref
      // moves mid-tick, and `headSha` is what a later tick compares against to
      // decide whether head actually moved — a ref *name* would always compare
      // equal to itself, so storing one silently disables that check.
      const headSha = await revParse(headRef, { cwd });
      if (headSha === null) continue;

      // No merge base means `baseRef` is unknown to this repo (a deleted or
      // never-fetched branch): fall back to head, i.e. an empty diff, rather
      // than showing the whole history as changed.
      const baseSha = (await mergeBase(review.baseRef, headSha, { cwd })) ?? headSha;

      // Build the file list (includes the one `hash-object` spawn for working).
      let newFiles;
      try {
        newFiles = await buildFileList(
          rev === 'working' ? { cwd, revision: rev, baseSha } : { cwd, revision: rev, baseSha, targetSha: headSha },
        );
      } catch {
        // A git error mid-tick — hold this revision's last good snapshot rather than crash the actor.
        continue;
      }

      this.#built.add(rev);
      const previous = this.#snapshots[rev];

      // The early-out: list identical -> stop. Zero UI work.
      const delta = diffFileLists(previous.files, newFiles);
      if (isEmptyDelta(delta)) {
        // The *files* are unchanged, but head may still have moved under them
        // (an amend, a rebase that preserved the tree). Per-file patch fetches
        // key off these shas, so keep them current even though there is nothing
        // for the client to redraw.
        this.#snapshots[rev] = { ...previous, baseSha, headSha };
        continue;
      }

      // Renames are derived from *this build's* rename detection (git diff -M
      // against `baseSha`), not from `delta.renamed` — a file that was
      // unmodified relative to base was never in the previous snapshot at all,
      // so the client-facing delta has nothing to call a "rename" for it, but
      // a thread anchored to its old path still needs to follow (SPEC §6).
      const renames: Rename[] = [];
      for (const f of newFiles) {
        if (f.oldPath !== null) renames.push({ from: f.oldPath, to: f.path });
      }
      // Thread anchors are re-derived only against the review's persisted
      // (default) revision. A non-default revision's file list can genuinely
      // differ from the default's — e.g. `working` has an uncommitted change
      // `head` doesn't — and re-anchoring the one shared thread row against
      // two different revisions' deltas in the same tick would race. Cross-
      // revision thread positions are handled separately at render time.
      if (rev === effectiveRevision) {
        if (renames.length > 0) {
          await renamePaths(this.#db, review.id, renames);
        }
        await this.#reanchorThreads(delta, renames, rev, cwd);
      }

      this.#snapshots[rev] = {
        reviewId: review.id,
        revision: rev,
        baseSha,
        headSha,
        files: newFiles,
      };
      this.#emit({ type: 'files.changed', reviewId: review.id, list: this.#snapshots[rev] });
    }

    // `#cachedRevisionState` (divergence, basesMismatched) is only ever
    // refreshed here, inside `#emitState`. `root`/`operation`/`prNumber`
    // changing are not the only things that can move it: `git` (HEAD moved),
    // `remote-pr` (the PR ref moved), and `remote-default` (`baseRef`'s
    // merge-base moved) all feed `divergence`/`basesMismatched` directly and
    // must also force a refresh, or the cache would keep serving values from
    // the last root/operation/pr-number change indefinitely.
    if (rootChanged || operationChanged || prNumberChanged || this.#stateSignalsFired(sources)) {
      await this.#emitState();
    }
  }

  /** Whether any of `sources` can move `divergence`/`basesMismatched` (see `#cachedRevisionState`). */
  #stateSignalsFired(sources: ReadonlySet<'root' | 'git' | 'remote-default' | 'remote-pr'>): boolean {
    return sources.has('git') || sources.has('remote-pr') || sources.has('remote-default');
  }

  /** Revisions that actually exist right now (SPEC §4's picker). */
  availableRevisions(): Revision[] {
    const available: Revision[] = [];
    if (this.#attachedPath !== null) available.push('working');
    available.push('head');
    if (this.#review.prNumber !== null) available.push('pr');
    return available;
  }

  /**
   * SPEC §4: the first time a named branch's history contains a `(repo, sha)`
   * review's pinned commit, adopt it. `git branch --contains` can return
   * several candidates; walk them in git's order and adopt the first one not
   * already owned by another review in this repo (the `(repo_id, branch)`
   * unique index forbids two reviews sharing a branch — stealing it would
   * silently orphan the other review's threads). If every candidate is
   * taken, stay detached: adoption is an optimisation, not a requirement.
   * Never let adoption failure take the tick down with it.
   */
  async #maybeAdoptBranch(): Promise<void> {
    const review = this.#review;
    if (review.branch !== null || review.pinnedSha === null) return;
    try {
      const result = await git(['branch', '--format=%(refname:short)', '--contains', review.pinnedSha], {
        cwd: this.#repo.rootPath,
      });
      if (result.exitCode !== 0) return;
      const text = bytesToText(result.stdout).trim();
      if (text === '') return;
      const candidates = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      for (const branchName of candidates) {
        const owner = await findReviewByBranch(this.#db, review.repoId, branchName);
        if (owner !== null) continue;
        this.#review = await adoptBranch(this.#db, review.id, branchName);
        return;
      }
    } catch {
      // Adoption is an optimisation; a failure here must not crash the tick.
      return;
    }
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
        if (sideBlob === t.anchorBlobSha) {
          if (!t.outdated) continue; // this thread's side didn't change — free
          // The file was reverted back to this thread's anchor blob: the
          // original startLine/endLine are valid again by definition.
          updates.push({
            id: t.id,
            startLine: t.startLine,
            endLine: t.endLine,
            anchorBlobSha: t.anchorBlobSha,
            outdated: false,
            changedSinceComment: true,
          });
          continue;
        }

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

  /**
   * Recomputes the expensive git-derived half of the state (`divergence`,
   * `basesMismatched`), stores it in `#cachedRevisionState`, and returns the
   * full `ReviewState` built from that plus the always-fresh cheap fields.
   * Only called from the tick path (`#emitState`) and, lazily, the first
   * `getState()` before any tick has run.
   */
  async #computeState(): Promise<ReviewState> {
    const review = this.#review;

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
        // Independent git calls — run them concurrently rather than serially.
        const [d, baseHead, basePr] = await Promise.all([
          divergence(headRef, prRef, { cwd }),
          mergeBase(review.baseRef, headRef, { cwd }),
          mergeBase(review.baseRef, prRef, { cwd }),
        ]);
        divergenceValue = d;
        basesMismatched = baseHead !== null && basePr !== null && baseHead !== basePr;
      } catch {
        // Any of the three throwing leaves both fields at their defaults.
        divergenceValue = null;
      }
    }

    this.#cachedRevisionState = { divergence: divergenceValue, basesMismatched };
    return this.#buildState();
  }

  /** Assembles a `ReviewState` from `#cachedRevisionState` plus the cheap fields, all computed fresh. */
  #buildState(): ReviewState {
    const review = this.#review;
    return {
      reviewId: review.id,
      availableRevisions: this.availableRevisions(),
      currentRevision: this.#resolveEffectiveRevision(),
      root: { attachedPath: this.#attachedPath, detachedReason: this.#detachedReason },
      divergence: this.#cachedRevisionState?.divergence ?? null,
      basesMismatched: this.#cachedRevisionState?.basesMismatched ?? false,
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
