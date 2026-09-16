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
import { gitOrThrow, bytesToText, type GitCallOptions } from './run.ts';

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
};

export type ListBranchesOptions = GitCallOptions & {
  /** Case-insensitive substring match on the branch's short name. */
  filter?: string;
  /** Applied after merge + sort, so it caps rows returned, not refs scanned. */
  limit?: number;
};

const REMOTE_PREFIX = 'refs/remotes/origin/';
const LOCAL_PREFIX = 'refs/heads/';

// Tab and newline are literal format codes `for-each-ref` supports directly
// (git-for-each-ref(1)) — no shell quoting hazards, and no need for a
// separator that could collide with a commit subject.
const FORMAT = '%(refname)%09%(objectname)%09%(committerdate:unix)%09%(authorname)%09%(subject)';

/**
 * `git for-each-ref` over `refs/heads` and `refs/remotes/origin`, merged so
 * a branch present on both sides is one row. Sourced from `for-each-ref`
 * rather than `branch -a` because it gives committer date and subject in a
 * single machine-readable call instead of one `branch` call plus a `log`
 * per ref.
 */
export async function listBranches(options: ListBranchesOptions): Promise<BranchSummary[]> {
  const result = await gitOrThrow(
    ['for-each-ref', '--sort=-committerdate', `--format=${FORMAT}`, 'refs/heads', 'refs/remotes/origin'],
    options,
  );
  const text = bytesToText(result.stdout);

  const byName = new Map<string, BranchSummary>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    // Subject is last so a tab inside it can't shift the fixed fields.
    const [refname, sha, dateText, authorName, ...rest] = line.split('\t');
    const subject = rest.length === 0 ? undefined : rest.join('\t');
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
