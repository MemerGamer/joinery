/**
 * The GitLab `Forge`: merge request discovery via the `glab` CLI. Same rule as
 * the GitHub forge: a missing or unauthenticated `glab` is data ("unavailable",
 * `null`), never a thrown error.
 *
 * Everything goes through `glab api projects/:fullpath/merge_requests…` run
 * inside the repo clone: glab fills `:fullpath` with the URL-encoded project
 * path (nested groups included) and picks the host from the clone's remote, so
 * self-hosted instances need no extra flag as long as `glab` is logged into them.
 */
import { z } from 'zod';
import type { CiStatus, PullDetail, PullState } from '@joinery/core';
import type {
  Forge,
  ForgeOptions,
  ListOpenPullsResult,
  MergedPrCommits,
  PullSearchHit,
  PullSummary,
  ResolvedPr,
} from './types.ts';

/** A `glab` call is a network round trip; one that hangs must not hold its caller (or its cache key) forever. */
const GLAB_TIMEOUT_MS = 30_000;

/**
 * Run `glab`, returning stdout on exit 0 and `null` on anything else — not
 * installed, unauthenticated, a non-GitLab remote, rate limited, or killed
 * after `GLAB_TIMEOUT_MS`. stderr is drained so a chatty failure can't fill
 * its pipe and stall the process.
 */
async function runGlab(args: readonly string[], cwd: string): Promise<string | null> {
  let proc;
  try {
    proc = Bun.spawn(['glab', ...args], {
      cwd,
      env: { ...process.env, NO_PROMPT: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: GLAB_TIMEOUT_MS,
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

/** `glab api` GET of a path under the current clone's project (`projects/:fullpath/…`). */
function runProjectApi(path: string, cwd: string): Promise<string | null> {
  return runGlab(['api', `projects/:fullpath/${path}`], cwd);
}

/** `glab api` GET of a path under an explicit `owner/name` (possibly nested) project. */
function runSlugApi(slug: string, path: string, cwd: string): Promise<string | null> {
  return runGlab(['api', `projects/${encodeURIComponent(slug)}/${path}`], cwd);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function unixOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Map a pipeline status onto `CiStatus`. `skipped`, `manual` and unknown
 * statuses carry no signal (`null`), like a pull with no checks.
 */
export function deriveCiStatus(status: string | null | undefined): CiStatus | null {
  switch (status) {
    case 'success':
      return 'passing';
    case 'failed':
    case 'canceled':
    case 'canceling':
      return 'failing';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
      return 'pending';
    default:
      return null;
  }
}

/** GitLab's merge request states: 'opened' | 'closed' | 'locked' | 'merged'. */
function pullStateOf(state: string, draft: boolean): PullState {
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : draft ? 'draft' : 'open';
}

const pipelineSchema = z.object({ status: z.string() }).nullable().default(null);
const userSchema = z.object({ username: z.string() }).nullable().default(null);

async function findOpenPrNumberForBranch(branch: string, options: ForgeOptions): Promise<number | null> {
  const stdout = await runProjectApi(
    `merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&order_by=updated_at&per_page=1`,
    options.cwd,
  );
  if (stdout === null) return null;
  const parsed = z.array(z.object({ iid: z.number().int().positive() })).safeParse(parseJson(stdout));
  return parsed.success ? (parsed.data[0]?.iid ?? null) : null;
}

const pullListItemSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().optional(),
  target_project_id: z.number().optional(),
  author: userSchema,
  updated_at: z.string(),
  draft: z.boolean().default(false),
  reviewers: z.array(userSchema).catch([]).default([]),
  head_pipeline: pipelineSchema,
});

// GitLab's list endpoint caps pages at 100; one page is enough for a review queue.
const OPEN_PULLS_LIMIT = 100;

/**
 * Open, same-project MRs. The list endpoint carries no line counts and
 * usually no pipeline, so `additions`/`deletions`/`changedFiles` are `null` and
 * `ci` is only set when GitLab happens to include `head_pipeline`.
 */
async function listOpenPulls(options: ForgeOptions & { login: string | null }): Promise<ListOpenPullsResult> {
  const stdout = await runProjectApi(
    `merge_requests?state=opened&order_by=updated_at&per_page=${String(OPEN_PULLS_LIMIT)}`,
    options.cwd,
  );
  if (stdout === null) return { available: false, pulls: [] };

  const parsed = z.array(pullListItemSchema).safeParse(parseJson(stdout));
  if (!parsed.success) return { available: true, pulls: [] };

  const { login } = options;
  const pulls: PullSummary[] = parsed.data
    // MRs from forks have a different source project; out of scope, as for GitHub.
    .filter((p) => p.source_project_id === undefined || p.source_project_id === p.target_project_id)
    .map((p) => {
      // Login not known yet: any requested reviewer counts, as on GitHub.
      const reviewers = p.reviewers.flatMap((r) => (r === null ? [] : [r.username]));
      return {
        number: p.iid,
        title: p.title,
        headRefName: p.source_branch,
        baseRefName: p.target_branch,
        authorLogin: p.author?.username ?? null,
        updatedAt: p.updated_at,
        updatedAtUnix: unixOf(p.updated_at),
        isDraft: p.draft,
        additions: null,
        deletions: null,
        changedFiles: null,
        ci: deriveCiStatus(p.head_pipeline?.status),
        reviewRequested: login === null ? reviewers.length > 0 : reviewers.includes(login),
        reviewId: null,
        reviewStatus: null,
      };
    });
  return { available: true, pulls };
}

const pullRefsSchema = z.object({ source_branch: z.string(), target_branch: z.string() });

async function resolvePr(prNumber: number, options: ForgeOptions): Promise<ResolvedPr | null> {
  const stdout = await runProjectApi(`merge_requests/${String(prNumber)}`, options.cwd);
  if (stdout === null) return null;
  const parsed = pullRefsSchema.safeParse(parseJson(stdout));
  return parsed.success
    ? { headRefName: parsed.data.source_branch, baseRefName: parsed.data.target_branch }
    : null;
}

const mergedPrSchema = z.object({
  state: z.string(),
  merge_commit_sha: z.string().nullable().default(null),
  // A squash or fast-forward merge has no merge commit, only the squash commit.
  squash_commit_sha: z.string().nullable().default(null),
  sha: z.string(),
});

async function viewMergedPrCommits(prNumber: number, options: ForgeOptions): Promise<MergedPrCommits | null> {
  const stdout = await runProjectApi(`merge_requests/${String(prNumber)}`, options.cwd);
  if (stdout === null) return null;
  const parsed = mergedPrSchema.safeParse(parseJson(stdout));
  if (!parsed.success || parsed.data.state !== 'merged') return null;
  const mergeCommit = parsed.data.merge_commit_sha ?? parsed.data.squash_commit_sha;
  return mergeCommit === null ? null : { mergeCommit, headRefOid: parsed.data.sha };
}

const pullViewSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().default(''),
  state: z.string(),
  draft: z.boolean().default(false),
  author: userSchema,
  target_branch: z.string(),
  head_pipeline: pipelineSchema,
  // A string, and "1000+" past the cap.
  changes_count: z.string().nullable().default(null),
  web_url: z.string().optional(),
});

/** One MR in full. GitLab reports no line counts, so only `changedFiles` is filled. */
async function viewPull(prNumber: number, options: ForgeOptions): Promise<PullDetail | null> {
  const stdout = await runProjectApi(`merge_requests/${String(prNumber)}`, options.cwd);
  if (stdout === null) return null;
  const parsed = pullViewSchema.safeParse(parseJson(stdout));
  if (!parsed.success) return null;
  const p = parsed.data;
  const changed = Number.parseInt(p.changes_count ?? '', 10);
  return {
    number: p.iid,
    title: p.title,
    body: p.description ?? '',
    state: pullStateOf(p.state, p.draft),
    authorLogin: p.author?.username ?? null,
    baseRefName: p.target_branch,
    ci: deriveCiStatus(p.head_pipeline?.status),
    additions: null,
    deletions: null,
    changedFiles: Number.isFinite(changed) ? changed : null,
    url: p.web_url ?? null,
  };
}

const searchHitSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().default(false),
  author: userSchema,
  updated_at: z.string(),
});

function toSearchHit(raw: unknown, slug: string): PullSearchHit | null {
  const parsed = searchHitSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    slug: slug.toLowerCase(),
    number: p.iid,
    title: p.title,
    state: pullStateOf(p.state, p.draft),
    authorLogin: p.author?.username ?? null,
    updatedAt: p.updated_at,
    updatedAtUnix: unixOf(p.updated_at),
  };
}

const SEARCH_LIMIT = 50;

/**
 * Search MRs of any state across `repos`, one request per project in parallel.
 * A number query fetches that iid; anything else is a `search=` over title and
 * description. `available: false` means `glab` can't be asked at all.
 */
async function searchPulls(
  query: string,
  repos: readonly { slug: string; cwd: string }[],
): Promise<{ available: boolean; pulls: PullSearchHit[] }> {
  const first = repos[0];
  if (first === undefined) return { available: true, pulls: [] };

  const numberMatch = /^#?(\d+)$/.exec(query);
  const path = numberMatch !== null
    ? `merge_requests/${numberMatch[1] ?? ''}`
    : `merge_requests?state=all&order_by=updated_at&per_page=${String(SEARCH_LIMIT)}&search=${encodeURIComponent(query)}`;
  const outputs = await Promise.all(repos.map((r) => runSlugApi(r.slug, path, r.cwd)));

  const pulls: PullSearchHit[] = [];
  outputs.forEach((stdout, i) => {
    const repo = repos[i];
    if (stdout === null || repo === undefined) return;
    const raw = parseJson(stdout);
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const hit = toSearchHit(item, repo.slug);
      if (hit !== null) pulls.push(hit);
    }
  });
  pulls.sort((a, b) => b.updatedAtUnix - a.updatedAtUnix);
  // Every project failing is "not found" when `glab` works, "unavailable" when it doesn't.
  if (pulls.length === 0 && outputs.every((o) => o === null)) {
    return { available: (await runGlab(['auth', 'status'], first.cwd)) !== null, pulls };
  }
  return { available: true, pulls: pulls.slice(0, SEARCH_LIMIT) };
}

async function currentLogin(cwd: string): Promise<string | null> {
  const stdout = await runGlab(['api', 'user'], cwd);
  if (stdout === null) return null;
  const parsed = z.object({ username: z.string() }).safeParse(parseJson(stdout));
  return parsed.success && parsed.data.username !== '' ? parsed.data.username : null;
}

export const gitlabForge: Forge = {
  kind: 'gitlab',
  cli: 'glab',
  setupHint: 'Check that `glab` is installed, authenticated (`glab auth login`), and the MR exists in this repo.',
  // GitLab keeps every MR's head here, open or not, even after its branch is deleted.
  pullHeadRef: (prNumber) => `refs/merge-requests/${String(prNumber)}/head`,
  currentLogin,
  findOpenPrNumberForBranch,
  listOpenPulls,
  searchPulls,
  resolvePr,
  viewMergedPrCommits,
  viewPull,
};
