/**
 * The GitHub `Forge`: PR discovery via the `gh` CLI. Every function here follows the same
 * rule: a missing or unauthenticated `gh` is data ("no PR known", "gh
 * unavailable"), never a thrown error — the caller never has to wrap these
 * in a try/catch to stay up.
 */
import { z } from 'zod';
import type { CiStatus, PullDetail } from '@joinery/core';
import type {
  Forge,
  ForgeOptions,
  ListOpenPullsResult,
  MergedPrCommits,
  PullSearchHit,
  ResolvedPr,
} from './types.ts';

/** A `gh` call is a network round trip; one that hangs must not hold its caller (or its cache key) forever. */
const GH_TIMEOUT_MS = 30_000;

/**
 * Run `gh`, returning stdout on exit 0 and `null` on anything else — not
 * installed, unauthenticated, a non-GitHub remote, rate limited, or killed
 * after `GH_TIMEOUT_MS`. stderr is drained so a chatty failure can't fill
 * its pipe and stall the process.
 */
async function runGh(args: readonly string[], cwd: string): Promise<string | null> {
  let proc;
  try {
    proc = Bun.spawn(['gh', ...args], {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: GH_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return exitCode === 0 ? stdout : null;
}

const prForBranchSchema = z.object({ number: z.number().int().positive(), state: z.string() });

/**
 * Resolve the open PR number for `branch`, or `null` if there isn't one (or
 * `gh` isn't installed/authenticated). Never throws: a missing/unauthed
 * `gh` is equivalent to "no PR known yet", not an engine error.
 *
 * `gh pr view <branch>` falls back to the branch's most recent merged or
 * closed PR when none is open, so the state is checked here — otherwise a
 * reused branch name would bind to an old, unrelated PR. The `--` keeps a
 * branch name from being read as a flag.
 */
async function findOpenPrNumberForBranch(
  branch: string,
  options: ForgeOptions,
): Promise<number | null> {
  const stdout = await runGh(['pr', 'view', '--json', 'number,state', '--', branch], options.cwd);
  if (stdout === null) return null;
  try {
    const parsed = prForBranchSchema.safeParse(JSON.parse(stdout));
    return parsed.success && parsed.data.state === 'OPEN' ? parsed.data.number : null;
  } catch {
    return null;
  }
}

// `statusCheckRollup` items come in two incompatible shapes depending on
// whether the check is a GitHub Actions "check run" or a legacy commit
// "status context" — every field is optional and the
// object is `.passthrough()`, so a shape gh changes tomorrow just carries no
// signal instead of throwing; the whole array further `.catch([])`s so a
// totally different `statusCheckRollup` shape degrades this PR's `ci` to
// `null` rather than failing `listOpenPulls` for every PR in the repo.
const rollupItemSchema = z
  .object({
    /** CheckRun-shaped: 'COMPLETED' | 'IN_PROGRESS' | 'QUEUED' | ... */
    status: z.string().optional(),
    /** CheckRun-shaped, only meaningful once `status === 'COMPLETED'`. */
    conclusion: z.string().nullable().optional(),
    /** StatusContext-shaped: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' */
    state: z.string().optional(),
  })
  .passthrough();
type RollupItem = z.infer<typeof rollupItemSchema>;
const statusCheckRollupSchema = z.array(rollupItemSchema).catch([]);

const reviewRequestItemSchema = z
  .object({
    login: z.string().optional(),
    name: z.string().optional(),
    __typename: z.string().optional(),
  })
  .passthrough();
const reviewRequestsSchema = z.array(reviewRequestItemSchema).catch([]);

const FAILING_VALUES = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR']);

/**
 * Roll up `statusCheckRollup` into one `CiStatus`: any failing check/status
 * wins outright, then any not-yet-completed/pending one, else passing when
 * there's at least one check, else `null` for "no checks at all".
 */
export function deriveCiStatus(rollup: readonly RollupItem[]): CiStatus | null {
  if (rollup.length === 0) return null;
  let anyFailing = false;
  let anyPending = false;
  for (const item of rollup) {
    if (item.conclusion !== null && item.conclusion !== undefined && FAILING_VALUES.has(item.conclusion)) {
      anyFailing = true;
    }
    if (item.state !== undefined && FAILING_VALUES.has(item.state)) {
      anyFailing = true;
    }
    if (item.status !== undefined && item.status !== 'COMPLETED') {
      anyPending = true;
    }
    if (item.state === 'PENDING' || item.state === 'EXPECTED') {
      anyPending = true;
    }
  }
  if (anyFailing) return 'failing';
  if (anyPending) return 'pending';
  return 'passing';
}

/**
 * True when the local `gh` login is among the requested reviewers; when the
 * login isn't known yet (cold cache / no `gh`), true iff anyone was
 * requested — better a false positive nudge than silently hiding it.
 */
export function deriveReviewRequested(
  requests: readonly { login?: string | undefined }[],
  login: string | null,
): boolean {
  if (login === null) return requests.length > 0;
  return requests.some((r) => r.login === login);
}

const pullListItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  author: z.object({ login: z.string() }).nullable().default(null),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  statusCheckRollup: statusCheckRollupSchema.optional().default([]),
  reviewRequests: reviewRequestsSchema.optional().default([]),
});

const OPEN_PULLS_LIMIT = 200;

/**
 * List open, same-repo PRs via `gh pr list`. Fork PRs are out of scope
 * (a harder, deliberately deferred case) — `gh pr list` run inside the registered
 * clone already only returns PRs against *this* repo, so no extra filtering
 * is needed here to exclude forks from other repos entirely; a fork PR
 * that targets this repo would still appear, and is handled the same as
 * any other PR since head/base resolution doesn't care where the branch
 * physically lives, only that `headRefName` names something `gh`/git can
 * resolve.
 */
async function listOpenPulls(options: ForgeOptions & { login: string | null }): Promise<ListOpenPullsResult> {
  const stdout = await runGh(
    [
      'pr',
      'list',
      '--state',
      'open',
      // `gh` defaults to 30, which silently drops older PRs (and with them
      // the CI/title of any review matched to one).
      '--limit',
      String(OPEN_PULLS_LIMIT),
      '--json',
      'number,title,headRefName,baseRefName,author,updatedAt,isDraft,additions,deletions,changedFiles,statusCheckRollup,reviewRequests',
    ],
    options.cwd,
  );
  if (stdout === null) return { available: false, pulls: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { available: true, pulls: [] };
  }
  const parsed = z.array(pullListItemSchema).safeParse(raw);
  if (!parsed.success) return { available: true, pulls: [] };

  const { login } = options;
  const pulls = parsed.data.map((p) => {
    const updatedAtMs = Date.parse(p.updatedAt);
    return {
      number: p.number,
      title: p.title,
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      authorLogin: p.author?.login ?? null,
      updatedAt: p.updatedAt,
      updatedAtUnix: Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : 0,
      isDraft: p.isDraft,
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      changedFiles: p.changedFiles ?? null,
      ci: deriveCiStatus(p.statusCheckRollup),
      reviewRequested: deriveReviewRequested(p.reviewRequests, login),
      reviewId: null,
      reviewStatus: null,
    };
  });
  return { available: true, pulls };
}

const pullRefsSchema = z.object({
  headRefName: z.string(),
  baseRefName: z.string(),
});

/**
 * Resolve a single PR number to its `(headRefName, baseRefName)` — the pair
 * that lets `POST /api/reviews` create/find the review at `(repo,
 * headRefName)` with `baseRef` set to the PR's *real* base, not the repo
 * default (stacked PRs diff against their actual base). Returns
 * `null` on any failure (missing/unauthed `gh`, unknown PR number, or a
 * malformed response) — the route turns that into a `badRequest`, since
 * unlike the "detectors" use above, the caller explicitly asked for this
 * one PR and deserves to know it failed rather than silently getting `null`
 * folded into "no PR yet".
 */
async function resolvePr(prNumber: number, options: ForgeOptions): Promise<ResolvedPr | null> {
  const stdout = await runGh(['pr', 'view', String(prNumber), '--json', 'headRefName,baseRefName'], options.cwd);
  if (stdout === null) return null;
  try {
    const parsed = pullRefsSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const mergedPrSchema = z.object({
  state: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullable().default(null),
  headRefOid: z.string(),
});

/**
 * The merge commit and head of a *merged* PR, for pinning the diff base of a
 * review opened after the merge. `null` for a PR that isn't merged, or on any
 * failure (missing/unauthed `gh`, unknown number, malformed response).
 */
async function viewMergedPrCommits(
  prNumber: number,
  options: ForgeOptions,
): Promise<MergedPrCommits | null> {
  const stdout = await runGh(['pr', 'view', String(prNumber), '--json', 'state,mergeCommit,headRefOid'], options.cwd);
  if (stdout === null) return null;
  try {
    const parsed = mergedPrSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success || parsed.data.state !== 'MERGED' || parsed.data.mergeCommit === null) return null;
    return { mergeCommit: parsed.data.mergeCommit.oid, headRefOid: parsed.data.headRefOid };
  } catch {
    return null;
  }
}

const pullViewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().default(''),
  /** 'OPEN' | 'CLOSED' | 'MERGED' */
  state: z.string(),
  isDraft: z.boolean().default(false),
  author: z.object({ login: z.string() }).nullable().default(null),
  baseRefName: z.string(),
  statusCheckRollup: statusCheckRollupSchema.optional().default([]),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
});

/**
 * One PR in full (description, state, CI, size) for the review's summary
 * card, in a single `gh pr view`. Any state, not just open. `null` on any
 * failure (missing/unauthed `gh`, unknown number, malformed response).
 */
async function viewPull(prNumber: number, options: ForgeOptions): Promise<PullDetail | null> {
  const stdout = await runGh(
    [
      'pr',
      'view',
      String(prNumber),
      '--json',
      'number,title,body,state,isDraft,author,baseRefName,statusCheckRollup,additions,deletions,changedFiles,url',
    ],
    options.cwd,
  );
  if (stdout === null) return null;
  try {
    const parsed = pullViewSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    const p = parsed.data;
    return {
      number: p.number,
      title: p.title,
      body: p.body ?? '',
      state: p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open',
      authorLogin: p.author?.login ?? null,
      baseRefName: p.baseRefName,
      ci: deriveCiStatus(p.statusCheckRollup),
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      changedFiles: p.changedFiles ?? null,
      url: p.url ?? null,
    };
  } catch {
    return null;
  }
}

const searchHitSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  /** `gh search` says 'open' | 'closed' | 'merged'; `gh pr view` says 'OPEN' | 'CLOSED' | 'MERGED'. */
  state: z.string(),
  isDraft: z.boolean().default(false),
  author: z.object({ login: z.string() }).nullable().default(null),
  updatedAt: z.string(),
  repository: z.object({ nameWithOwner: z.string() }).optional(),
});

function toSearchHit(raw: unknown, slug: string | undefined): PullSearchHit | null {
  const parsed = searchHitSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const hitSlug = slug ?? p.repository?.nameWithOwner;
  if (hitSlug === undefined) return null;
  const state = p.state.toLowerCase();
  const updatedAtMs = Date.parse(p.updatedAt);
  return {
    slug: hitSlug.toLowerCase(),
    number: p.number,
    title: p.title,
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : p.isDraft ? 'draft' : 'open',
    authorLogin: p.author?.login ?? null,
    updatedAt: p.updatedAt,
    updatedAtUnix: Number.isFinite(updatedAtMs) ? Math.floor(updatedAtMs / 1000) : 0,
  };
}

const SEARCH_LIMIT = 50;
const SEARCH_FIELDS = 'number,title,state,author,updatedAt,isDraft';

/**
 * Search PRs of any state across `repos` (`slug` = `owner/name`, `cwd` = a
 * clone to run `gh` in). A number query asks each repo for that PR in
 * parallel (a repo without it just contributes nothing); anything else is
 * one `gh search prs`. `available: false` means `gh` can't be asked at all.
 */
async function searchPulls(
  query: string,
  repos: readonly { slug: string; cwd: string }[],
): Promise<{ available: boolean; pulls: PullSearchHit[] }> {
  const first = repos[0];
  if (first === undefined) return { available: true, pulls: [] };

  const numberMatch = /^#?(\d+)$/.exec(query);
  if (numberMatch !== null) {
    const outputs = await Promise.all(
      repos.map((r) =>
        runGh(['pr', 'view', numberMatch[1] ?? '', '--repo', r.slug, '--json', SEARCH_FIELDS], r.cwd),
      ),
    );
    const pulls: PullSearchHit[] = [];
    outputs.forEach((stdout, i) => {
      const repo = repos[i];
      if (stdout === null || repo === undefined) return;
      try {
        const hit = toSearchHit(JSON.parse(stdout), repo.slug);
        if (hit !== null) pulls.push(hit);
      } catch {
        // Malformed response: treat as not found.
      }
    });
    // Every repo failing is "not found" when `gh` works, "unavailable" when it doesn't.
    if (pulls.length === 0 && outputs.every((o) => o === null)) {
      return { available: (await runGh(['auth', 'status'], first.cwd)) !== null, pulls };
    }
    return { available: true, pulls };
  }

  const stdout = await runGh(
    [
      'search',
      'prs',
      ...repos.flatMap((r) => ['--repo', r.slug]),
      '--limit',
      String(SEARCH_LIMIT),
      '--json',
      `${SEARCH_FIELDS},repository`,
      '--',
      query,
    ],
    first.cwd,
  );
  if (stdout === null) return { available: false, pulls: [] };
  try {
    const raw: unknown = JSON.parse(stdout);
    if (!Array.isArray(raw)) return { available: true, pulls: [] };
    const pulls = raw.flatMap((item) => toSearchHit(item, undefined) ?? []);
    return { available: true, pulls };
  } catch {
    return { available: true, pulls: [] };
  }
}

async function currentLogin(cwd: string): Promise<string | null> {
  const stdout = await runGh(['api', 'user', '--jq', '.login'], cwd);
  const login = stdout?.trim() ?? '';
  return login === '' ? null : login;
}

export const githubForge: Forge = {
  kind: 'github',
  cli: 'gh',
  setupHint: 'Check that `gh` is installed, authenticated (`gh auth status`), and the PR exists in this repo.',
  // GitHub keeps every PR's head here, open or not, even after its branch is deleted.
  pullHeadRef: (prNumber) => `refs/pull/${String(prNumber)}/head`,
  currentLogin,
  findOpenPrNumberForBranch,
  listOpenPulls,
  searchPulls,
  resolvePr,
  viewMergedPrCommits,
  viewPull,
};
