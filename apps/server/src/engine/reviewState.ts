/**
 * The one place that decides a review's base and head commits, and the one
 * writer of `review_state`. The repo poller (`repoPoller.ts`) and a review's
 * live worker (`reviewEngine.ts`) both call in here; Homebase and the API only
 * read what this stores. Nothing else may re-derive any of it.
 *
 * Head: the first rung of the ladder that resolves —
 *
 *   a. attached worktree      -> HEAD
 *   b. local branch tip       -> refs/heads/<branch>
 *   c. remote-tracking tip    -> refs/remotes/origin/<branch>
 *   d. the PR's head          -> refs/review/pr/<id> (PR reviews only)
 *   e. the review's pinned sha
 *   f. the review's own pin   -> refs/review/<id>
 *
 * Base: `merge-base(origin/<baseRef>, head)`, where `baseRef` is the PR's
 * target branch as the forge reports it (kept current by the poller), else the
 * repo's default branch. When head is already inside the base (merged, often
 * with the branch kept) that merge-base is head itself, so the base before the
 * merge is used instead: the one the forge reported, else the last non-empty
 * base pinned at `refs/review/base/<id>`.
 */
import type { FileEntry, HeadSource, PullDetail, Repo, Review } from '@joinery/core';
import {
  baseMergeBase,
  buildFileList,
  bytesToText,
  gitOrThrow,
  pinReviewBaseRef,
  pinReviewRef,
  revParse,
} from '../git/index.ts';
import {
  getReviewState,
  putReviewState,
  type Db,
  type ReviewStateFields,
  type StoredReviewState,
} from '../db/index.ts';
import { resolveRoot } from './root.ts';

export type HeadTarget = { readonly sha: string; readonly source: HeadSource };

/** What the forge said that the range depends on. */
export type ForgeFacts = {
  /** The forge reports the PR merged. */
  readonly merged: boolean;
  /** The base before the merge, from the forge (`repoPoller.ts`). */
  readonly mergedBaseSha: string | null;
};

export type ReviewRange = {
  readonly headSha: string;
  readonly headSource: HeadSource;
  readonly baseSha: string;
  /** Head is already inside the base, and the diff shows what was merged. */
  readonly merged: boolean;
};

const NO_FORGE_FACTS: ForgeFacts = { merged: false, mergedBaseSha: null };

/** The head ladder (see the file comment). Null when no rung resolves. */
export async function resolveHead(review: Review, attachedPath: string | null, cwd: string): Promise<HeadTarget | null> {
  const rungs: ReadonlyArray<{ ref: string; source: HeadSource } | null> = [
    attachedPath !== null ? { ref: 'HEAD', source: 'worktree' } : null,
    review.branch !== null ? { ref: `refs/heads/${review.branch}`, source: 'local' } : null,
    review.branch !== null ? { ref: `refs/remotes/origin/${review.branch}`, source: 'remote' } : null,
    // A closed or merged PR's branch is usually deleted; the forge keeps
    // the PR's head ref, which the repo poll fetches into this ref.
    review.prNumber !== null ? { ref: `refs/review/pr/${review.id}`, source: 'pin' } : null,
    review.pinnedSha !== null ? { ref: review.pinnedSha, source: 'pinned-sha' } : null,
    { ref: `refs/review/${review.id}`, source: 'pin' },
  ];
  for (const rung of rungs) {
    if (rung === null) continue;
    const sha = await revParse(rung.ref, { cwd });
    if (sha !== null) return { sha, source: rung.source };
  }
  return null;
}

/** The base for `headSha` (see the file comment), and whether that makes it a merged diff. */
export async function resolveBase(
  review: Review,
  headSha: string,
  cwd: string,
  forge: ForgeFacts,
): Promise<{ baseSha: string; merged: boolean }> {
  const mergeBaseSha = await baseMergeBase(review.baseRef, headSha, { cwd });
  // `baseRef` unknown to this repo (a deleted or never-fetched branch): an
  // empty diff rather than the whole history as changed.
  if (mergeBaseSha === null) return { baseSha: headSha, merged: false };
  if (mergeBaseSha !== headSha) return { baseSha: mergeBaseSha, merged: false };
  const before = forge.mergedBaseSha ?? (await revParse(`refs/review/base/${review.id}`, { cwd }));
  if (before !== null && before !== headSha) return { baseSha: before, merged: true };
  return { baseSha: headSha, merged: forge.merged };
}

export async function resolveReviewRange(params: {
  readonly repo: Repo;
  readonly review: Review;
  readonly attachedPath: string | null;
  readonly forge?: ForgeFacts;
}): Promise<ReviewRange | null> {
  const cwd = params.attachedPath ?? params.repo.rootPath;
  const head = await resolveHead(params.review, params.attachedPath, cwd);
  if (head === null) return null;
  const base = await resolveBase(params.review, head.sha, cwd, params.forge ?? NO_FORGE_FACTS);
  return { headSha: head.sha, headSource: head.source, baseSha: base.baseSha, merged: base.merged };
}

/** The `pr` revision: the PR's fetched head, against the same base rule. Null before the PR ref is fetched. */
export async function resolvePrRange(params: {
  readonly review: Review;
  readonly cwd: string;
  readonly forge?: ForgeFacts;
}): Promise<{ headSha: string; baseSha: string } | null> {
  const headSha = await revParse(`refs/review/pr/${params.review.id}`, { cwd: params.cwd });
  if (headSha === null) return null;
  const base = await resolveBase(params.review, headSha, params.cwd, params.forge ?? NO_FORGE_FACTS);
  return { headSha, baseSha: base.baseSha };
}

/** The last shas this process pinned per review, so an unmoved range costs no `update-ref`. */
const pinned = new Map<string, { head: string | null; base: string | null }>();

/**
 * Keep `refs/review/<id>` on head (so it survives the branch being deleted)
 * and `refs/review/base/<id>` on the last non-empty base (so a merge keeps
 * showing what it changed). Best-effort: a failed pin never fails a caller.
 */
export async function pinRange(repo: Repo, reviewId: string, range: ReviewRange): Promise<void> {
  const last = pinned.get(reviewId) ?? { head: null, base: null };
  const cwd = repo.rootPath;
  try {
    if (last.head !== range.headSha) {
      await pinReviewRef(reviewId, range.headSha, { cwd });
      last.head = range.headSha;
    }
    if (!range.merged && range.baseSha !== range.headSha && last.base !== range.baseSha) {
      await pinReviewBaseRef(reviewId, range.baseSha, { cwd });
      last.base = range.baseSha;
    }
  } catch {
    // Best-effort keepalive.
  }
  pinned.set(reviewId, last);
}

/** Forget a deleted review's pin cache. */
export function forgetPins(reviewId: string): void {
  pinned.delete(reviewId);
}

/** What the forge reports about a review's PR, as the poller last saw it. */
export type PullFacts = {
  readonly pull: PullDetail | null;
  readonly pullHeadSha: string | null;
  readonly pullUpdatedAt: string | null;
  readonly mergedBaseSha: string | null;
};

export const NO_PULL: PullFacts = { pull: null, pullHeadSha: null, pullUpdatedAt: null, mergedBaseSha: null };

export function pullFactsOf(state: StoredReviewState | null): PullFacts {
  if (state === null) return NO_PULL;
  return {
    pull: state.pull,
    pullHeadSha: state.pullHeadSha,
    pullUpdatedAt: state.pullUpdatedAt,
    mergedBaseSha: state.mergedBaseSha,
  };
}

export function forgeFactsOf(facts: PullFacts): ForgeFacts {
  return { merged: facts.pull?.state === 'merged', mergedBaseSha: facts.mergedBaseSha };
}

/** `git log -1 --format=%an%x00%ct%x00%s <sha>`, parsed into its three NUL-separated fields. */
async function readTipCommit(
  cwd: string,
  sha: string,
): Promise<{ authorName: string | null; committedAt: number | null; subject: string | null }> {
  const result = await gitOrThrow(['log', '-1', '--format=%an%x00%ct%x00%s', sha], { cwd });
  const text = bytesToText(result.stdout).replace(/\n+$/, '');
  const [authorName, committedAtText, subject] = text.split('\0');
  const committedAt = committedAtText !== undefined && committedAtText !== '' ? Number(committedAtText) : NaN;
  return {
    authorName: authorName === undefined || authorName === '' ? null : authorName,
    committedAt: Number.isFinite(committedAt) ? committedAt : null,
    subject: subject === undefined ? null : subject,
  };
}

export type RefreshDeps = {
  readonly db: Db;
  /** Called after a changed state committed, with its review id. */
  readonly onChanged: (reviewId: string) => void;
};

export type RefreshOptions = {
  /** Already resolved by the caller (the live worker); resolved here when omitted. */
  readonly attachedPath?: string | null;
  /** New forge facts from the poller; omitted keeps the stored ones. */
  readonly pull?: PullFacts;
  /** The `head` file list the caller already built for exactly `range`, to skip a rebuild. */
  readonly built?: { readonly range: ReviewRange; readonly files: readonly FileEntry[] };
};

/** Per-review chain, so the poller and the worker never write one review's state at once. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Work out the review's range and, when anything moved, store the next
 * `review_state` version and announce it. Returns the stored state (the
 * previous one when nothing changed or head can't be resolved). Never throws.
 */
export function refreshReviewState(
  deps: RefreshDeps,
  repo: Repo,
  review: Review,
  options: RefreshOptions = {},
): Promise<StoredReviewState | null> {
  const previous = chains.get(review.id) ?? Promise.resolve();
  const next = previous.then(() => refreshOnce(deps, repo, review, options)).catch(() => null);
  chains.set(review.id, next);
  void next.finally(() => {
    if (chains.get(review.id) === next) chains.delete(review.id);
  });
  return next;
}

async function refreshOnce(
  deps: RefreshDeps,
  repo: Repo,
  review: Review,
  options: RefreshOptions,
): Promise<StoredReviewState | null> {
  const stored = await getReviewState(deps.db, review.id);
  const facts = options.pull ?? pullFactsOf(stored);
  const attachedPath =
    options.attachedPath !== undefined ? options.attachedPath : (await resolveRoot(repo, review)).attachedPath;
  const range = await resolveReviewRange({ repo, review, attachedPath, forge: forgeFactsOf(facts) });
  if (range === null) return stored;
  await pinRange(repo, review.id, range);

  const cwd = attachedPath ?? repo.rootPath;
  const sameRange = stored !== null && stored.headSha === range.headSha && stored.baseSha === range.baseSha;
  let diff: Pick<ReviewStateFields, 'filesTotal' | 'additions' | 'deletions' | 'blobByPath'>;
  let tip: Pick<ReviewStateFields, 'subject' | 'authorName' | 'committedAt'>;
  if (sameRange) {
    diff = stored;
    tip = stored;
  } else {
    const built = options.built;
    const files =
      built !== undefined && built.range.headSha === range.headSha && built.range.baseSha === range.baseSha
        ? built.files
        : await buildFileList({ cwd, revision: 'head', baseSha: range.baseSha, targetSha: range.headSha });
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
    diff = {
      filesTotal: files.length,
      additions,
      deletions,
      blobByPath: Object.fromEntries(files.map((f) => [f.path, f.newBlob])),
    };
    tip = await readTipCommit(cwd, range.headSha);
  }

  const fields: ReviewStateFields = {
    headSha: range.headSha,
    baseSha: range.baseSha,
    headSource: range.headSource,
    merged: range.merged,
    filesTotal: diff.filesTotal,
    additions: diff.additions,
    deletions: diff.deletions,
    blobByPath: diff.blobByPath,
    subject: tip.subject,
    authorName: tip.authorName,
    committedAt: tip.committedAt,
    pull: facts.pull,
    pullHeadSha: facts.pullHeadSha,
    pullUpdatedAt: facts.pullUpdatedAt,
    mergedBaseSha: facts.mergedBaseSha,
  };
  if (stored !== null && sameFields(stored, fields)) return stored;

  const written = await putReviewState(deps.db, review.id, fields, stored?.version ?? null);
  deps.onChanged(review.id);
  return written;
}

function sameFields(stored: StoredReviewState, fields: ReviewStateFields): boolean {
  const { reviewId: _id, version: _version, ...rest } = stored;
  return stableJson(rest) === stableJson(fields);
}

/** `JSON.stringify` with object keys sorted, so key order never reads as a change. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
