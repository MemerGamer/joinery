/**
 * Per-review git stats for Homebase: diff size, tip commit
 * metadata, and the file list a git-less summary can't know. Deliberately
 * standalone from `ReviewEngine` — no worktree attachment, no watchers, just
 * enough git to answer "what does this review's head look like right now"
 * for a hundred reviews without waking a hundred engines.
 *
 * Head ladder (trimmed to what a detached read needs — no attached
 * worktree rung, since this never touches one):
 *
 *   a. local branch tip    -> refs/heads/<branch>
 *   b. remote-tracking tip -> refs/remotes/origin/<branch>
 *   c. the review's pinned sha
 *   d. the review's own pin -> refs/review/<id>
 *
 * Base is `merge-base(baseRef, head)`, falling back to
 * `refs/remotes/origin/<baseRef>` when the merge-base can't be found (a
 * `baseRef` this repo never fetched); null when neither resolves.
 *
 * Never throws: any git failure anywhere in here returns `null`, so one
 * review's broken worktree/missing ref never fails the whole Homebase list
 * (see `homebase.ts`, which relies on this).
 */
import type { FileEntry, Repo, Review } from '@review/core';
import { buildFileList } from './filelist.ts';
import { mergeBase, revParse } from './repo.ts';
import { bytesToText, gitOrThrow } from './run.ts';

export type ReviewGitStats = {
  readonly headSha: string;
  readonly baseSha: string;
  /** The tip commit's subject line; null only if `git log` produced no output. */
  readonly subject: string | null;
  readonly authorName: string | null;
  /** Committer date of `head`, unix seconds; null if unparseable. */
  readonly committedAt: number | null;
  readonly files: readonly FileEntry[];
  readonly additions: number;
  readonly deletions: number;
};

type CacheEntry = {
  readonly headSha: string;
  readonly baseSha: string;
  readonly stats: ReviewGitStats;
};

/**
 * Keyed by review id, valid only while `(headSha, baseSha)` haven't moved —
 * a warm hit (nothing changed since the last call) costs two
 * `rev-parse`/`merge-base` spawns instead of the full diff/log rebuild.
 */
const cache = new Map<string, CacheEntry>();

async function resolveHeadSha(repo: Repo, review: Review): Promise<string | null> {
  const cwd = repo.rootPath;
  const rungs: ReadonlyArray<string | null> = [
    review.branch !== null ? `refs/heads/${review.branch}` : null,
    review.branch !== null ? `refs/remotes/origin/${review.branch}` : null,
    review.pinnedSha,
    `refs/review/${review.id}`,
  ];
  for (const rung of rungs) {
    if (rung === null) continue;
    const sha = await revParse(rung, { cwd });
    if (sha !== null) return sha;
  }
  return null;
}

async function resolveBaseSha(repo: Repo, review: Review, headSha: string): Promise<string | null> {
  const cwd = repo.rootPath;
  const viaMergeBase = await mergeBase(review.baseRef, headSha, { cwd });
  if (viaMergeBase !== null) return viaMergeBase;
  return await revParse(`refs/remotes/origin/${review.baseRef}`, { cwd });
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

/**
 * Resolve `review`'s head/base, build its file list, and roll up
 * additions/deletions and the tip commit's subject/author/date. `null` when
 * head or base can't be resolved, or on any git failure along the way.
 */
export async function computeReviewGitStats(repo: Repo, review: Review): Promise<ReviewGitStats | null> {
  try {
    const cwd = repo.rootPath;
    const headSha = await resolveHeadSha(repo, review);
    if (headSha === null) return null;
    const baseSha = await resolveBaseSha(repo, review, headSha);
    if (baseSha === null) return null;

    const cached = cache.get(review.id);
    if (cached !== undefined && cached.headSha === headSha && cached.baseSha === baseSha) {
      return cached.stats;
    }

    const [files, tip] = await Promise.all([
      buildFileList({ cwd, revision: 'head', baseSha, targetSha: headSha }),
      readTipCommit(cwd, headSha),
    ]);

    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }

    const stats: ReviewGitStats = {
      headSha,
      baseSha,
      subject: tip.subject,
      authorName: tip.authorName,
      committedAt: tip.committedAt,
      files,
      additions,
      deletions,
    };
    cache.set(review.id, { headSha, baseSha, stats });
    return stats;
  } catch {
    return null;
  }
}
