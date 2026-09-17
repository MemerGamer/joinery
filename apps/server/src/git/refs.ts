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
  /** Commits ahead of / behind the repo's default branch; null when git can't say. */
  ahead: number | null;
  behind: number | null;
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
        ahead,
        behind,
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
