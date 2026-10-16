/**
 * Branch discovery for the "open any branch, not just ones added via CLI"
 * flow: list local heads AND remote-tracking refs in one call, merged into
 * one row per branch name, so a branch that is checked out locally *and*
 * exists on `origin` is not offered twice in the picker.
 *
 * Only `origin` is considered for the remote side — the rest of this
 * codebase (`repo.ts`'s `remoteIdentity`/`defaultBranch`, the engine's
 * remote poll) already assumes a single `origin` remote, so mirroring that
 * here keeps "which remote" a non-question rather than inventing a
 * multi-remote UI nobody asked for.
 */
import { compareBranches, type BranchSort, type ReviewStatus } from '@joinery/core';
import { git, gitOrThrow, bytesToText, type GitCallOptions } from './run.ts';

export type BranchSummary = {
  /** Short name, e.g. "feat/x" — with no `refs/heads/` or `origin/` prefix. */
  name: string;
  hasLocalRef: boolean;
  hasRemoteRef: boolean;
  tipSha: string;
  /** Committer date, unix seconds, of whichever ref (local/remote) is newer. */
  committerDate: number;
  subject: string | null;
  authorName: string | null;
  /** That review's status; filled by the route alongside `reviewId`, null until then. */
  reviewStatus: ReviewStatus | null;
  /** Commits ahead of / behind the repo's default branch; null when git can't say. */
  ahead: number | null;
  behind: number | null;
  /**
   * Whether the default branch already contains it. From `ahead` when git
   * can count (2.41+); otherwise from `for-each-ref --no-merged`, which older
   * git has too. Null when there's no default branch to compare against.
   */
  merged: boolean | null;
};

export type ListBranchesOptions = GitCallOptions & {
  /** Case-insensitive substring match on the branch's short name. */
  filter?: string;
  /** Applied after merge + sort, so it caps rows returned, not refs scanned. */
  limit?: number;
  /** The repo's default branch short name, to resolve the ahead/behind comparison ref against. */
  defaultBranch: string;
};

const REMOTE_PREFIX = 'refs/remotes/origin/';
const LOCAL_PREFIX = 'refs/heads/';

// Tab and newline are literal format codes `for-each-ref` supports directly
// (git-for-each-ref(1)) — no shell quoting hazards, and no need for a
// separator that could collide with a commit subject.
const BASE_FIELDS = '%(refname)%09%(objectname)%09%(committerdate:unix)%09%(authorname)';
// Subject stays last in both variants: it may contain a literal tab, and
// splitting on '\t' with a fixed prefix of known-safe fields lets us just
// re-join everything after them.
const FORMAT_NO_AHEAD_BEHIND = `${BASE_FIELDS}%09%(subject)`;
const formatWithAheadBehind = (ref: string) => `${BASE_FIELDS}%09%(ahead-behind:${ref})%09%(subject)`;

/**
 * Resolve the ref to compare branches against for ahead/behind: the local
 * default branch if it exists, else its `origin` remote-tracking ref, else
 * `null` (no default branch known locally at all — ahead/behind is skipped
 * entirely rather than guessing).
 */
async function resolveDefaultRef(defaultBranch: string, options: GitCallOptions): Promise<string | null> {
  const localRef = `refs/heads/${defaultBranch}`;
  const local = await git(['rev-parse', '--verify', localRef], options);
  if (local.exitCode === 0) return localRef;

  const remoteRef = `${REMOTE_PREFIX}${defaultBranch}`;
  const remote = await git(['rev-parse', '--verify', remoteRef], options);
  if (remote.exitCode === 0) return remoteRef;

  return null;
}

function parseAheadBehind(text: string | undefined): { ahead: number | null; behind: number | null } {
  if (text === undefined) return { ahead: null, behind: null };
  const [aheadText, behindText] = text.trim().split(/\s+/u);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { ahead: null, behind: null };
  return { ahead, behind };
}

/**
 * `git for-each-ref` over `refs/heads` and `refs/remotes/origin`, merged so
 * a branch present on both sides is one row. Sourced from `for-each-ref`
 * rather than `branch -a` because it gives committer date and subject in a
 * single machine-readable call instead of one `branch` call plus a `log`
 * per ref.
 */
export async function listBranches(options: ListBranchesOptions): Promise<BranchSummary[]> {
  const defaultRef = await resolveDefaultRef(options.defaultBranch, options);

  let text: string;
  let hasAheadBehind: boolean;
  if (defaultRef === null) {
    const result = await gitOrThrow(
      ['for-each-ref', '--sort=-committerdate', `--format=${FORMAT_NO_AHEAD_BEHIND}`, 'refs/heads', 'refs/remotes/origin'],
      options,
    );
    text = bytesToText(result.stdout);
    hasAheadBehind = false;
  } else {
    const attempt = await git(
      ['for-each-ref', '--sort=-committerdate', `--format=${formatWithAheadBehind(defaultRef)}`, 'refs/heads', 'refs/remotes/origin'],
      options,
    );
    if (attempt.exitCode === 0) {
      text = bytesToText(attempt.stdout);
      hasAheadBehind = true;
    } else {
      // Older git (< 2.41) doesn't know `%(ahead-behind:...)` and exits
      // non-zero for the whole call — retry without it rather than failing
      // branch discovery outright.
      const fallback = await gitOrThrow(
        ['for-each-ref', '--sort=-committerdate', `--format=${FORMAT_NO_AHEAD_BEHIND}`, 'refs/heads', 'refs/remotes/origin'],
        options,
      );
      text = bytesToText(fallback.stdout);
      hasAheadBehind = false;
    }
  }

  const byName = new Map<string, BranchSummary>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const refname = parts[0];
    const sha = parts[1];
    const dateText = parts[2];
    const authorName = parts[3];
    const aheadBehindText = hasAheadBehind ? parts[4] : undefined;
    const subjectParts = hasAheadBehind ? parts.slice(5) : parts.slice(4);
    const subject = subjectParts.length === 0 ? undefined : subjectParts.join('\t');
    if (refname === undefined || sha === undefined) continue;

    let name: string;
    let isRemote: boolean;
    if (refname.startsWith(LOCAL_PREFIX)) {
      name = refname.slice(LOCAL_PREFIX.length);
      isRemote = false;
    } else if (refname.startsWith(REMOTE_PREFIX)) {
      name = refname.slice(REMOTE_PREFIX.length);
      // `origin/HEAD` is a symref to the default branch, not a branch of
      // its own — surfacing it would offer a fake "branch" that is really
      // an alias, and it would collide with nothing to merge against.
      if (name === 'HEAD') continue;
      isRemote = true;
    } else {
      continue;
    }

    const date = Number(dateText ?? '0');
    const committerDate = Number.isFinite(date) ? date : 0;
    const { ahead, behind } = parseAheadBehind(aheadBehindText);
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, {
        name,
        hasLocalRef: !isRemote,
        hasRemoteRef: isRemote,
        tipSha: sha,
        committerDate,
        subject: subject === undefined || subject === '' ? null : subject,
        authorName: authorName === undefined || authorName === '' ? null : authorName,
        reviewStatus: null,
        ahead,
        behind,
        merged: ahead === null ? null : ahead === 0,
      });
      continue;
    }

    existing.hasLocalRef ||= !isRemote;
    existing.hasRemoteRef ||= isRemote;
    // Local and remote tips usually agree; when they don't (unpushed or
    // stale-fetch), prefer whichever side is newer so "tip sha" answers a
    // meaningful question without a second divergence lookup here.
    if (committerDate > existing.committerDate) {
      existing.tipSha = sha;
      existing.committerDate = committerDate;
      existing.subject = subject === undefined || subject === '' ? null : subject;
      existing.authorName = authorName === undefined || authorName === '' ? null : authorName;
      existing.ahead = ahead;
      existing.behind = behind;
      existing.merged = ahead === null ? null : ahead === 0;
    }
  }

  // Git too old to count: ask which refs the default branch doesn't contain
  // instead. A branch is unmerged if either of its refs is.
  if (!hasAheadBehind && defaultRef !== null) {
    const result = await git(['for-each-ref', `--no-merged=${defaultRef}`, '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], options);
    if (result.exitCode === 0) {
      const unmerged = new Set<string>();
      for (const refname of bytesToText(result.stdout).split('\n')) {
        if (refname.startsWith(LOCAL_PREFIX)) unmerged.add(refname.slice(LOCAL_PREFIX.length));
        else if (refname.startsWith(REMOTE_PREFIX)) unmerged.add(refname.slice(REMOTE_PREFIX.length));
      }
      for (const branch of byName.values()) branch.merged = !unmerged.has(branch.name);
    }
  }

  let branches = [...byName.values()];
  const filter = options.filter?.trim().toLowerCase();
  if (filter !== undefined && filter !== '') {
    branches = branches.filter((b) => b.name.toLowerCase().includes(filter));
  }
  branches.sort((a, b) => b.committerDate - a.committerDate);
  if (options.limit !== undefined) {
    branches = branches.slice(0, options.limit);
  }
  return branches;
}

export type SelectBranchesOptions = {
  sort?: BranchSort;
  /** Keep only branches whose tip commit's author is this name (case-insensitive). */
  author?: string;
  /** Keep only branches with commits the default branch doesn't have; the default branch itself stays. */
  unmerged?: boolean;
  /** `local`: has a local branch. `origin`: exists only on origin. */
  where?: 'local' | 'origin';
  /** Keep only branches committed to at or after this unix time. */
  since?: number;
  /** `unreviewed`: no review, or an unstarted draft. `reviewing`: open or orphaned. Reads `reviewStatus`, so fill it first. */
  review?: 'unreviewed' | 'reviewing';
  /** The repo's default branch short name, for `unmerged`. */
  defaultBranch: string;
  limit?: number;
};

/**
 * Explore's filters and sort over the full branch list `listBranches`
 * returns, then the limit, so a filter looks through every branch rather
 * than just the most recent page.
 */
export function selectBranches<T extends BranchSummary>(branches: readonly T[], options: SelectBranchesOptions): T[] {
  const author = options.author?.trim().toLowerCase();
  let selected = branches.filter((b) => {
    if (author !== undefined && (b.authorName ?? '').trim().toLowerCase() !== author) return false;
    // Unknown (no default branch to compare with) isn't evidence of being merged, so it stays.
    if (options.unmerged === true && b.name !== options.defaultBranch && b.merged === true) return false;
    if (options.where === 'local' && !b.hasLocalRef) return false;
    if (options.where === 'origin' && b.hasLocalRef) return false;
    if (options.since !== undefined && b.committerDate < options.since) return false;
    if (options.review === 'unreviewed' && b.reviewStatus !== null && b.reviewStatus !== 'draft') return false;
    if (options.review === 'reviewing' && b.reviewStatus !== 'open' && b.reviewStatus !== 'orphaned') return false;
    return true;
  });
  selected = selected.sort(compareBranches(options.sort ?? 'recent'));
  return options.limit === undefined ? selected : selected.slice(0, options.limit);
}

/** How many `rev-list` counts run at once when git can't count in `for-each-ref`. */
const COUNT_CONCURRENCY = 8;

/**
 * Fill in `ahead`/`behind` for branches that don't have them, one
 * `rev-list --left-right --count` each — for git older than 2.41, whose
 * `for-each-ref` can't count. That's a spawn per branch, so callers pass only
 * what they need: the page being returned, or everything when sorting by
 * the counts. Mutates the branches; a failed count stays null.
 */
export async function countAheadBehind(
  branches: readonly BranchSummary[],
  defaultBranch: string,
  options: GitCallOptions,
): Promise<void> {
  const missing = branches.filter((b) => b.ahead === null || b.behind === null);
  if (missing.length === 0) return;
  const defaultRef = await resolveDefaultRef(defaultBranch, options);
  if (defaultRef === null) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < missing.length) {
      const branch = missing[next++];
      if (branch === undefined) return;
      // Left: on the default branch only (behind); right: on the branch only (ahead).
      const result = await git(['rev-list', '--left-right', '--count', `${defaultRef}...${branch.tipSha}`], options);
      if (result.exitCode !== 0) continue;
      const [behind, ahead] = bytesToText(result.stdout).trim().split(/\s+/u).map(Number);
      if (ahead === undefined || behind === undefined || !Number.isFinite(ahead) || !Number.isFinite(behind)) continue;
      branch.ahead = ahead;
      branch.behind = behind;
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, missing.length) }, worker));
}
