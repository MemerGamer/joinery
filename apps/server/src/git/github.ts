/**
 * PR discovery via the `gh` CLI (SPEC §5, remote poll; SPEC §4 "open any
 * branch or PR from the web UI"). Every function here follows the same
 * rule: a missing or unauthenticated `gh` is data ("no PR known", "gh
 * unavailable"), never a thrown error — the caller never has to wrap these
 * in a try/catch to stay up.
 */
import { z } from 'zod';

export type FindOpenPrOptions = { cwd: string };

/**
 * Resolve the open PR number for `branch`, or `null` if there isn't one (or
 * `gh` isn't installed/authenticated). Never throws: a missing/unauthed
 * `gh` is equivalent to "no PR known yet", not an engine error.
 */
export async function findOpenPrNumberForBranch(
  branch: string,
  options: FindOpenPrOptions,
): Promise<number | null> {
  let proc;
  try {
    proc = Bun.spawn(['gh', 'pr', 'view', branch, '--json', 'number', '--jq', '.number'], {
      cwd: options.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return null;
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const n = Number(stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const pullListItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  author: z.object({ login: z.string() }).nullable().default(null),
  updatedAt: z.string(),
  isDraft: z.boolean(),
});

export type PullSummary = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  updatedAt: string;
  isDraft: boolean;
};

export type ListOpenPullsResult = {
  /**
   * Whether `gh` could be asked at all — `false` means "not installed" or
   * "not authenticated", which the UI renders as a one-line note, distinct
   * from `true` with an empty `pulls` array ("asked, there just aren't
   * any open PRs").
   */
  available: boolean;
  pulls: PullSummary[];
};

/**
 * List open, same-repo PRs via `gh pr list`. Fork PRs are out of scope
 * (SPEC §4 "Taking over someone else's PR" covers why they're a harder,
 * deliberately deferred case) — `gh pr list` run inside the registered
 * clone already only returns PRs against *this* repo, so no extra filtering
 * is needed here to exclude forks from other repos entirely; a fork PR
 * that targets this repo would still appear, and is handled the same as
 * any other PR since head/base resolution doesn't care where the branch
 * physically lives, only that `headRefName` names something `gh`/git can
 * resolve.
 */
export async function listOpenPulls(options: FindOpenPrOptions): Promise<ListOpenPullsResult> {
  let proc;
  try {
    proc = Bun.spawn(
      [
        'gh',
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,title,headRefName,baseRefName,author,updatedAt,isDraft',
      ],
      { cwd: options.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
  } catch {
    return { available: false, pulls: [] };
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return { available: false, pulls: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { available: true, pulls: [] };
  }
  const parsed = z.array(pullListItemSchema).safeParse(raw);
  if (!parsed.success) return { available: true, pulls: [] };

  const pulls = parsed.data.map((p) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    authorLogin: p.author?.login ?? null,
    updatedAt: p.updatedAt,
    isDraft: p.isDraft,
  }));
  return { available: true, pulls };
}

const pullRefsSchema = z.object({
  headRefName: z.string(),
  baseRefName: z.string(),
});

export type ResolvedPr = {
  headRefName: string;
  baseRefName: string;
};

/**
 * Resolve a single PR number to its `(headRefName, baseRefName)` — the pair
 * that lets `POST /api/reviews` create/find the review at `(repo,
 * headRefName)` with `baseRef` set to the PR's *real* base, not the repo
 * default (stacked PRs diff against their actual base, SPEC §4). Returns
 * `null` on any failure (missing/unauthed `gh`, unknown PR number, or a
 * malformed response) — the route turns that into a `badRequest`, since
 * unlike the "detectors" use above, the caller explicitly asked for this
 * one PR and deserves to know it failed rather than silently getting `null`
 * folded into "no PR yet".
 */
export async function resolvePr(prNumber: number, options: FindOpenPrOptions): Promise<ResolvedPr | null> {
  let proc;
  try {
    proc = Bun.spawn(['gh', 'pr', 'view', String(prNumber), '--json', 'headRefName,baseRefName'], {
      cwd: options.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return null;
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  try {
    const parsed = pullRefsSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
