/**
 * Every route, driven by the `api` map from
 * `@joinery/core`: validate params through each route's `body`/`query`
 * schema, return exactly its `response` shape.
 */
import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import {
  addRepoBodySchema,
  setAllViewedBodySchema,
  resolveAllThreadsBodySchema,
  askAgentBodySchema,
  createReviewBodySchema,
  createThreadBodySchema,
  generateReadingOrderBodySchema,
  listDirsQuerySchema,
  listBranchesQuerySchema,
  listPullsQuerySchema,
  searchPullsQuerySchema,
  versionQuerySchema,
  listReviewsQuerySchema,
  markViewedBodySchema,
  readingOrderPlanSchema,
  replyBodySchema,
  revisionSchema,
  setReactionBodySchema,
  setRevisionBodySchema,
  setReviewStatusBodySchema,
  NULL_BLOB,
  type ServerEvent,
  type Thread,
} from '@joinery/core';
import { z } from 'zod';
import { getVersionInfo, startUpdate } from '../updates.ts';
import { deleteRepoFully, deleteReviewFully } from '../cleanup.ts';
import { clearCachedAnswers, clearWorktrees, getDataUsage, getFullDiskAccess, getIntegrations, openFullDiskAccess, restartServer } from '../settings.ts';
import {
  appendReply,
  createReview,
  createThread,
  deleteComment,
  deleteThread,
  findReviewByBranch,
  findReviewByPinnedSha,
  getActiveRun,
  getCommentThreadId,
  getReadingOrder,
  getRepoById,
  getRepoByPath,
  getReview,
  getReviewState,
  getRun,
  getThreadWithComments,
  listEvents,
  listRepos,
  listReviews,
  listThreadsByReview,
  listUnfinishedRuns,
  listViewed,
  markViewed,
  resolveThread,
  setCurrentRevision,
  setReaction,
  setStatus,
  touchOpened,
  unmarkViewed,
  unresolveThread,
  upsertRepo,
  writeReadingOrderPlan,
  type Db,
} from '../db/index.ts';
import { listDirs } from '../fs/dirs.ts';
import { buildReviewSummaries, getMeCached, getStoredPulls } from '../homebase.ts';
import { searchPullsCached } from '../pullSearchCache.ts';
import type { StoredCacheDeps } from '../storedCache.ts';
import {
  canonicalizePath,
  defaultBranch as gitDefaultBranch,
  detectForge,
  forgeFor,
  getFileContents,
  gitUserName,
  countAheadBehind,
  selectBranches,
  getFilePatch,
  listBranches,
  remoteHost,
  remoteIdentity,
  showToplevel,
} from '../git/index.ts';
import type { EngineRegistry } from '../engine/index.ts';
import { captureContext } from '../engine/anchor.ts';
import { projectThreads } from '../engine/threadProjection.ts';
import { cancelRun, generateReadingOrder, requestThreadReply } from '../agent/runs.ts';
import type { Invoke } from '../agent/tools.ts';
import { resolveRunCwd } from '../agent/worktree.ts';
import { badRequest, conflict, notFound, pathError } from './errors.ts';
import { parseBody, parseQuery } from './validate.ts';

export type RoutesDeps = {
  readonly db: Db;
  readonly registry: EngineRegistry;
  /** In-process app driver, built by `createApp` before routes are mounted — handed to `runs.ts` for the embedded agent's `joinery` tools. */
  readonly invoke: Invoke;
};

const diffQuerySchema = z.object({ path: z.string().min(1), rev: z.enum(['working', 'head', 'pr']).optional() });
const filesQuerySchema = z.object({ rev: revisionSchema.optional() });
const threadsQuerySchema = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  rev: revisionSchema.optional(),
});
const reviewPullQuerySchema = z.object({ refresh: z.enum(['true', 'false']).optional() });
const resolveBodySchema = z.object({ resolved: z.boolean().default(true) });

async function requireEngine(deps: RoutesDeps, reviewId: string) {
  const engine = await deps.registry.get(reviewId);
  if (engine === null) throw notFound(`review ${reviewId} not found`);
  return engine;
}

async function requireReview(deps: RoutesDeps, reviewId: string) {
  const review = await getReview(deps.db, reviewId);
  if (review === null) throw notFound(`review ${reviewId} not found`);
  return review;
}

/** Stop a thread's live agent runs before deleting it, so none writes into a thread that's gone. */
async function cancelThreadRuns(deps: RoutesDeps, thread: Thread): Promise<void> {
  const runs = (await listUnfinishedRuns(deps.db)).filter((r) => r.threadId === thread.id);
  for (const run of runs) {
    await cancelRun({ db: deps.db, invoke: deps.invoke, emit: (e) => deps.registry.dispatch(thread.reviewId, e) }, run.id);
  }
}

async function requireThread(deps: RoutesDeps, threadId: string): Promise<Thread> {
  const thread = await getThreadWithComments(deps.db, threadId);
  if (thread === null) throw notFound(`thread ${threadId} not found`);
  return thread;
}

export function buildRoutes(deps: RoutesDeps): Hono {
  const app = new Hono();
  const dispatch = (reviewId: string, event: ServerEvent): void => deps.registry.dispatch(reviewId, event);
  const { bus, pollers } = deps.registry;
  // A background `me` refresh that changed what Homebase shows tells it to re-read.
  const homeDeps: StoredCacheDeps = { db: deps.db, onUpdated: () => bus.changed('home') };

  // --- repos ---

  app.get('/api/repos', async (c) => {
    const repos = await listRepos(deps.db);
    return c.json({ repos });
  });

  app.post('/api/repos', async (c) => {
    const body = await parseBody(addRepoBodySchema, c);
    // A relative path would resolve against the *server's* cwd, silently
    // registering a different repo than the caller meant. Clients resolve
    // before sending; refuse rather than guess.
    if (!isAbsolute(body.path)) {
      throw badRequest(
        `repo path must be absolute, got: ${body.path}`,
        'Pass a full path, e.g. `joinery repos add "$(pwd)"`.',
      );
    }
    let canonical: string;
    try {
      canonical = await canonicalizePath(body.path);
    } catch (err) {
      throw pathError(err, body.path);
    }
    let toplevel: string;
    try {
      toplevel = await showToplevel({ cwd: canonical });
    } catch {
      throw badRequest(`not a git repository: ${body.path}`);
    }
    const rootPath = await canonicalizePath(toplevel);

    const identity = await remoteIdentity({ cwd: rootPath });
    const branch = (await gitDefaultBranch({ cwd: rootPath })) ?? 'main';

    const host = await remoteHost({ cwd: rootPath });
    const repo = await upsertRepo(deps.db, {
      rootPath,
      remoteHost: host,
      forge: host === null ? null : await detectForge(host, rootPath),
      remoteOwner: identity.owner,
      remoteName: identity.name,
      defaultBranch: branch,
    });
    pollers.ensure(repo.id);
    bus.changed('home');
    return c.json({ repo }, 201);
  });

  app.delete('/api/repos/:id', async (c) => {
    const id = c.req.param('id');
    if ((await getRepoById(deps.db, id)) === null) throw notFound(`repo ${id} not found`);
    await deleteRepoFully(deps, id);
    return c.json({ ok: true as const });
  });

  // --- settings page ---

  app.get('/api/settings/integrations', async (c) => {
    return c.json(await getIntegrations(deps.db));
  });

  app.get('/api/settings/full-disk-access', async (c) => {
    return c.json(await getFullDiskAccess());
  });

  app.post('/api/settings/full-disk-access/open', async (c) => {
    await openFullDiskAccess();
    return c.json({ ok: true as const });
  });

  app.post('/api/settings/restart', (c) => {
    restartServer();
    return c.json({ started: true as const }, 202);
  });

  app.get('/api/settings/data', async (c) => {
    return c.json(await getDataUsage(deps.db));
  });

  app.post('/api/settings/worktrees/clear', async (c) => {
    return c.json({ removed: await clearWorktrees(deps.db) });
  });

  app.post('/api/settings/cached-answers/clear', async (c) => {
    return c.json({ removed: await clearCachedAnswers(deps.db) });
  });

  // Server-side folder browsing for the add-repo picker.
  app.get('/api/fs/dirs', async (c) => {
    const query = parseQuery(listDirsQuerySchema, c);
    return c.json(await listDirs(query.path, query.hidden !== undefined));
  });

  app.get('/api/me', async (c) => {
    return c.json(await getMeCached(homeDeps));
  });

  app.get('/api/version', async (c) => {
    const query = parseQuery(versionQuerySchema, c);
    return c.json(await getVersionInfo(query.refresh === 'true'));
  });

  app.post('/api/update', (c) => {
    startUpdate();
    return c.json({ started: true as const }, 202);
  });

  // --- discovery: branches and PRs for a registered repo, so the web UI can
  // open any of them, not just ones added via the CLI ---

  app.get('/api/repos/:id/branches', async (c) => {
    const id = c.req.param('id');
    const repo = await getRepoById(deps.db, id);
    if (repo === null) throw notFound(`repo ${id} not found`);
    const query = parseQuery(listBranchesQuerySchema, c);
    const [all, reviews, author] = await Promise.all([
      listBranches({
        cwd: repo.rootPath,
        ...(query.filter === undefined ? {} : { filter: query.filter }),
        defaultBranch: repo.defaultBranch,
      }),
      listReviews(deps.db, { repoId: repo.id }),
      query.mine === 'true' ? gitUserName(repo.rootPath) : Promise.resolve(null),
    ]);
    // Statuses go on before filtering, since the review filter reads them.
    const reviewByBranch = new Map(reviews.flatMap((r) => (r.branch === null ? [] : [[r.branch, r] as const])));
    const withReviews = all.map((branch) => {
      const existing = reviewByBranch.get(branch.name);
      return { ...branch, reviewId: existing?.id ?? null, reviewStatus: existing?.status ?? null };
    });
    // "Mine" with no `user.name` set can't match anything, so it lists nothing rather than everything.
    if (query.mine === 'true' && author === null) return c.json({ branches: [] });
    // Git that can't count ahead/behind in `for-each-ref` (< 2.41) gets them one
    // branch at a time: for every branch when they decide the order, else only
    // for the page returned (below).
    const sortsByCount = query.sort === 'ahead' || query.sort === 'behind';
    if (sortsByCount) await countAheadBehind(withReviews, repo.defaultBranch, { cwd: repo.rootPath });
    const branches = selectBranches(withReviews, {
      defaultBranch: repo.defaultBranch,
      limit: query.limit ?? 50,
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      ...(author === null ? {} : { author }),
      ...(query.unmerged === 'true' ? { unmerged: true } : {}),
      ...(query.where === undefined ? {} : { where: query.where }),
      ...(query.since === undefined ? {} : { since: Math.floor(Date.now() / 1000) - query.since * 24 * 60 * 60 }),
      ...(query.review === undefined ? {} : { review: query.review }),
    });
    if (!sortsByCount) await countAheadBehind(branches, repo.defaultBranch, { cwd: repo.rootPath });
    // `merged` only feeds the filter; it isn't part of the API's branch shape.
    return c.json({ branches: branches.map(({ merged, ...branch }) => branch) });
  });

  app.get('/api/repos/:id/pulls', async (c) => {
    const id = c.req.param('id');
    const repo = await getRepoById(deps.db, id);
    if (repo === null) throw notFound(`repo ${id} not found`);
    const query = parseQuery(listPullsQuerySchema, c);
    // Answered from what the repo poller stored; `refresh` polls now, and
    // the `repo:<id>` event tells the screen when the new list landed.
    if (query.refresh === 'true') pollers.kick(repo.id);
    const result = await getStoredPulls(deps.db, repo);
    const pulls = await Promise.all(
      result.pulls.map(async (pull) => {
        const existing = await findReviewByBranch(deps.db, repo.id, pull.headRefName);
        return { ...pull, reviewId: existing?.id ?? null, reviewStatus: existing?.status ?? null };
      }),
    );
    return c.json({
      available: result.available,
      pulls,
      unavailableReason: result.unavailableReason,
      unavailableHost: result.unavailableHost,
    });
  });

  app.get('/api/pulls/search', async (c) => {
    const query = parseQuery(searchPullsQuerySchema, c);
    const wanted = query.repos === undefined ? null : new Set(query.repos.split(',').filter((id) => id !== ''));
    // Only repos on a supported forge can be searched.
    const repos = (await listRepos(deps.db)).filter(
      (r) => forgeFor(r).kind !== 'none' && (wanted === null || wanted.has(r.id)),
    );
    const result = await searchPullsCached(query.q, repos);
    const idBySlug = new Map(repos.map((r) => [`${r.remoteOwner}/${r.remoteName}`.toLowerCase(), r.id]));
    const pulls = result.pulls.flatMap(({ slug, ...hit }) => {
      const repoId = idBySlug.get(slug);
      return repoId === undefined ? [] : [{ repoId, ...hit }];
    });
    return c.json({
      available: result.available,
      pulls,
      unavailableReason: result.unavailableReason,
      unavailableHost: result.unavailableHost,
    });
  });

  // --- reviews ---

  app.get('/api/reviews', async (c) => {
    const query = parseQuery(listReviewsQuerySchema, c);
    const reviews = await listReviews(deps.db, query.status === undefined ? undefined : { status: query.status });
    if (query.refresh === 'true') pollers.kickAll();
    const summaries = await buildReviewSummaries(deps.db, reviews);
    return c.json({ reviews, summaries });
  });

  app.post('/api/reviews', async (c) => {
    const body = await parseBody(createReviewBodySchema, c);

    let repo = body.repoId !== undefined ? await getRepoById(deps.db, body.repoId) : null;
    if (repo === null && body.repoPath !== undefined) {
      const canonical = await canonicalizePath(body.repoPath);
      repo = await getRepoByPath(deps.db, canonical);
    }
    if (repo === null) throw badRequest('repoId or a registered repoPath is required');

    // A bare `prNumber` (no branch/sha) resolves via the forge to the PR's real
    // `(headRefName, baseRefName)` before falling into the normal
    // branch/sha identity logic below. A PR review is then identified as
    // `(repo, headRefName)` with `prNumber` set — the SAME identity as a
    // branch review, so `findReviewByBranch`'s dedupe already
    // handles "open PR #123 twice" without any PR-specific lookup table.
    // Fork PRs are out of scope; same-repo PRs only.
    let branch = body.branch;
    let base = body.base;
    if (branch === undefined && body.sha === undefined && body.prNumber === undefined) {
      throw badRequest('one of branch or sha (or prNumber, resolved via the forge) is required');
    }
    // An open PR's head and target branch come from the pulls the repo poller
    // stored; only one it hasn't seen (an old PR from search) asks the forge.
    if (body.prNumber !== undefined && body.sha === undefined && (branch === undefined || base === undefined)) {
      const known = (await getStoredPulls(deps.db, repo)).pulls.find((p) => p.number === body.prNumber);
      if (known !== undefined) {
        branch ??= known.headRefName;
        base ??= known.baseRefName;
      }
    }
    if (branch === undefined && body.sha === undefined && body.prNumber !== undefined) {
      const forge = forgeFor(repo);
      const resolved = await forge.resolvePr(body.prNumber, { cwd: repo.rootPath });
      if (resolved === null) {
        throw badRequest(`could not resolve PR #${String(body.prNumber)} via ${forge.cli}`, forge.setupHint);
      }
      branch = resolved.headRefName;
      // Stacked PRs diff against their real base, never the repo default.
      base = resolved.baseRefName;
    }

    let review =
      branch !== undefined
        ? await findReviewByBranch(deps.db, repo.id, branch)
        : body.sha !== undefined
          ? await findReviewByPinnedSha(deps.db, repo.id, body.sha)
          : null;

    if (review === null) {
      review = await createReview(deps.db, {
        repoId: repo.id,
        branch: branch ?? null,
        pinnedSha: body.sha ?? null,
        baseRef: base ?? repo.defaultBranch,
        prNumber: body.prNumber ?? null,
        status: body.status,
      });
      // The repo's poller picks the new review up (PR, target branch, CI) now.
      pollers.ensure(repo.id);
      bus.changed('home');
    }

    const engine = await requireEngine(deps, review.id);
    const state = await engine.getState();
    return c.json({ review, repo, state }, 201);
  });

  app.get('/api/reviews/:id', async (c) => {
    const id = c.req.param('id');
    const review = await requireReview(deps, id);
    const repo = await getRepoById(deps.db, review.repoId);
    if (repo === null) throw notFound(`repo ${review.repoId} not found`);
    const engine = await requireEngine(deps, id);
    const state = await engine.getState();
    const readingOrderRun = await getActiveRun(deps.db, id, 'reading_order');
    // Opening the review marks its unread-agent-replies window read:
    // must happen after the response is built, so this open is measured
    // against the *previous* `last_opened_at`, not the one it just set.
    await touchOpened(deps.db, id);
    return c.json({ review, repo, state, readingOrderRun });
  });

  app.delete('/api/reviews/:id', async (c) => {
    const review = await requireReview(deps, c.req.param('id'));
    await deleteReviewFully(deps, review);
    return c.json({ ok: true as const });
  });

  app.get('/api/reviews/:id/pull', async (c) => {
    const id = c.req.param('id');
    const review = await requireReview(deps, id);
    const repo = await getRepoById(deps.db, review.repoId);
    if (repo === null) throw notFound(`repo ${review.repoId} not found`);
    const query = parseQuery(reviewPullQuerySchema, c);
    if (query.refresh === 'true') pollers.kick(repo.id);
    const pull = (await getReviewState(deps.db, id))?.pull ?? null;
    return c.json({ pull });
  });

  app.get('/api/reviews/:id/files', async (c) => {
    const id = c.req.param('id');
    const query = parseQuery(filesQuerySchema, c);
    const engine = await requireEngine(deps, id);
    const list = engine.getFileList(query.rev);
    const viewedRows = await listViewed(deps.db, id);
    const viewed = viewedRows.map((v) => ({ path: v.path, blobSha: v.blobSha }));
    return c.json({ list, viewed });
  });

  app.get('/api/reviews/:id/diff', async (c) => {
    const id = c.req.param('id');
    const query = parseQuery(diffQuerySchema, c);
    const engine = await requireEngine(deps, id);
    const renderCtx = engine.getRenderContext();
    if (query.rev !== undefined && query.rev !== renderCtx.revision) {
      throw badRequest(
        `only the review's current revision ("${renderCtx.revision}") can be fetched right now`,
        `POST /api/reviews/${id}/revision with { "revision": "${query.rev}" } first`,
      );
    }
    const entry = engine.getFileList().files.find((f) => f.path === query.path);
    if (entry === undefined) throw notFound(`no diff entry for path "${query.path}"`);

    const targetSha = renderCtx.revision === 'working' ? undefined : renderCtx.headSha;
    const patch = await getFilePatch({
      cwd: renderCtx.cwd,
      revision: renderCtx.revision,
      baseSha: renderCtx.baseSha,
      ...(targetSha === undefined ? {} : { targetSha }),
      entry: { path: entry.path, oldPath: entry.oldPath, oldBlob: entry.oldBlob, newBlob: entry.newBlob, binary: entry.binary },
    });
    return c.json({ patch });
  });

  app.get('/api/reviews/:id/contents', async (c) => {
    const id = c.req.param('id');
    const query = parseQuery(diffQuerySchema, c);
    const engine = await requireEngine(deps, id);
    const renderCtx = engine.getRenderContext();
    if (query.rev !== undefined && query.rev !== renderCtx.revision) {
      throw badRequest(
        `only the review's current revision ("${renderCtx.revision}") can be fetched right now`,
        `POST /api/reviews/${id}/revision with { "revision": "${query.rev}" } first`,
      );
    }
    const entry = engine.getFileList().files.find((f) => f.path === query.path);
    if (entry === undefined) throw notFound(`no diff entry for path "${query.path}"`);

    const contents = await getFileContents({
      cwd: renderCtx.cwd,
      revision: renderCtx.revision,
      path: entry.path,
      oldBlob: entry.oldBlob,
      newBlob: entry.newBlob,
      catFile: engine.getCatFile(),
    });
    return c.json({ contents });
  });

  // --- reading order ---

  app.get('/api/reviews/:id/reading-order', async (c) => {
    const id = c.req.param('id');
    const engine = await requireEngine(deps, id);
    const currentPaths = engine.getFileList().files.map((f) => f.path);
    const readingOrder = await getReadingOrder(deps.db, id, currentPaths);
    return c.json({ readingOrder });
  });

  app.put('/api/reviews/:id/reading-order', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const plan = await parseBody(readingOrderPlanSchema, c);
    const readingOrder = await writeReadingOrderPlan(deps.db, id, plan);
    dispatch(id, { type: 'reading_order.updated', reviewId: id });
    return c.json({ readingOrder }, 201);
  });

  app.post('/api/reviews/:id/reading-order/generate', async (c) => {
    const id = c.req.param('id');
    const review = await requireReview(deps, id);
    const body = await parseBody(generateReadingOrderBodySchema, c);
    // One run at a time: a second request (palette, CLI, double click) gets
    // the run already in progress instead of starting a competing one.
    const active = await getActiveRun(deps.db, id, 'reading_order');
    if (active !== null) return c.json({ run: active }, 202);
    const engine = await requireEngine(deps, id);
    const files = engine.getFileList().files;
    const cwd = await resolveRunCwd({ db: deps.db }, review, engine);
    const run = await generateReadingOrder({ db: deps.db, invoke: deps.invoke, emit: (e) => dispatch(id, e) }, id, {
      cwd,
      files,
      loadPull: async () => {
        const pull = (await getReviewState(deps.db, id))?.pull ?? null;
        return pull === null ? null : { title: pull.title, body: pull.body };
      },
      ...(body.model === undefined ? {} : { model: body.model }),
    });
    return c.json({ run }, 202);
  });

  // --- threads ---

  app.get('/api/reviews/:id/threads', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const query = parseQuery(threadsQuerySchema, c);
    const threads =
      query.status === 'open'
        ? await listThreadsByReview(deps.db, id, { unresolvedOnly: true })
        : query.status === 'resolved'
          ? (await listThreadsByReview(deps.db, id)).filter((t) => t.status === 'resolved')
          : await listThreadsByReview(deps.db, id);

    const engine = await requireEngine(deps, id);
    const renderCtx = engine.getRenderContext();
    if (query.rev === undefined || query.rev === renderCtx.revision) {
      return c.json({ threads });
    }
    // A different revision than the one thread rows are persisted against —
    // project positions for display, without writing anything back.
    const projected = await projectThreads(threads, engine.getFileList(query.rev).files, {
      cwd: renderCtx.cwd,
      revision: query.rev,
      catFile: engine.getCatFile(),
    });
    return c.json({ threads: projected });
  });

  app.post('/api/reviews/:id/threads', async (c) => {
    const id = c.req.param('id');
    const review = await requireReview(deps, id);
    const body = await parseBody(createThreadBodySchema, c);
    const engine = await requireEngine(deps, id);
    const entry = engine.getFileList().files.find((f) => f.path === body.path);
    if (entry === undefined) throw notFound(`no diff entry for path "${body.path}"`);

    const blobSha = body.side === 'old' ? entry.oldBlob : entry.newBlob;
    if (blobSha === NULL_BLOB) {
      throw badRequest(`path "${body.path}" has no ${body.side} side to anchor to`);
    }

    const renderCtx = engine.getRenderContext();
    const contents = await getFileContents({
      cwd: renderCtx.cwd,
      revision: renderCtx.revision,
      path: entry.path,
      oldBlob: entry.oldBlob,
      newBlob: entry.newBlob,
      catFile: engine.getCatFile(),
    });
    const text = body.side === 'old' ? contents.oldContents : contents.newContents;
    if (text === null) throw badRequest(`could not read ${body.side} side of "${body.path}"`);

    const { context, hash } = captureContext(text.split('\n'), body.startLine, body.endLine);

    const thread = await createThread(deps.db, {
      reviewId: id,
      path: body.path,
      side: body.side,
      startLine: body.startLine,
      endLine: body.endLine,
      anchorBlobSha: blobSha,
      anchorContextHash: hash,
      anchorContext: context,
      body: body.body,
    });
    dispatch(id, { type: 'thread.created', reviewId: id, thread });

    const run = body.askAgent
      ? await requestThreadReply({ db: deps.db, invoke: deps.invoke, emit: (e) => dispatch(id, e) }, review, thread.id, engine, body.model)
      : null;
    return c.json({ thread, run }, 201);
  });

  app.get('/api/threads/:id', async (c) => {
    const thread = await requireThread(deps, c.req.param('id'));
    return c.json({ thread });
  });

  app.delete('/api/threads/:id', async (c) => {
    const threadId = c.req.param('id');
    const existing = await requireThread(deps, threadId);
    await cancelThreadRuns(deps, existing);
    await deleteThread(deps.db, threadId);
    dispatch(existing.reviewId, { type: 'thread.deleted', reviewId: existing.reviewId, threadId });
    return c.json({ ok: true as const });
  });

  app.post('/api/threads/:id/replies', async (c) => {
    const threadId = c.req.param('id');
    const thread = await requireThread(deps, threadId);
    const body = await parseBody(replyBodySchema, c);

    await appendReply(deps.db, {
      threadId,
      author: body.author,
      body: body.body,
      ...(body.agentRunId === undefined ? {} : { agentRunId: body.agentRunId }),
    });
    const updated = await requireThread(deps, threadId);
    dispatch(thread.reviewId, { type: 'thread.updated', reviewId: thread.reviewId, thread: updated });

    let run = null;
    if (body.askAgent) {
      const review = await requireReview(deps, thread.reviewId);
      const engine = await requireEngine(deps, thread.reviewId);
      run = await requestThreadReply(
        { db: deps.db, invoke: deps.invoke, emit: (e) => dispatch(thread.reviewId, e) },
        review,
        threadId,
        engine,
        body.model,
      );
    }
    return c.json({ thread: updated, run }, 201);
  });

  app.post('/api/threads/:id/resolve', async (c) => {
    const threadId = c.req.param('id');
    const existing = await requireThread(deps, threadId);
    const body = await parseBody(resolveBodySchema, c);
    const thread = body.resolved ? await resolveThread(deps.db, threadId) : await unresolveThread(deps.db, threadId);
    dispatch(existing.reviewId, { type: 'thread.updated', reviewId: existing.reviewId, thread });
    return c.json({ thread });
  });

  app.post('/api/reviews/:id/threads/resolve-all', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const body = await parseBody(resolveAllThreadsBodySchema, c);
    const changed: Thread[] = [];
    for (const t of await listThreadsByReview(deps.db, id)) {
      if ((t.status === 'resolved') === body.resolved) continue;
      const thread = body.resolved ? await resolveThread(deps.db, t.id) : await unresolveThread(deps.db, t.id);
      dispatch(id, { type: 'thread.updated', reviewId: id, thread });
      changed.push(thread);
    }
    return c.json({ threads: changed });
  });

  app.post('/api/threads/:id/ask', async (c) => {
    const threadId = c.req.param('id');
    const thread = await requireThread(deps, threadId);
    const body = await parseBody(askAgentBodySchema, c);
    const review = await requireReview(deps, thread.reviewId);
    const engine = await requireEngine(deps, thread.reviewId);
    const run = await requestThreadReply(
      { db: deps.db, invoke: deps.invoke, emit: (e) => dispatch(thread.reviewId, e) },
      review,
      threadId,
      engine,
      body.model,
    );
    return c.json({ run }, 202);
  });

  app.post('/api/comments/:id/reactions', async (c) => {
    const commentId = c.req.param('id');
    const threadId = await getCommentThreadId(deps.db, commentId);
    if (threadId === null) throw notFound(`comment ${commentId} not found`);
    const existing = await requireThread(deps, threadId);
    const body = await parseBody(setReactionBodySchema, c);
    await setReaction(deps.db, { commentId, actor: body.actor, kind: body.kind, on: body.on });
    const thread = await requireThread(deps, threadId);
    dispatch(existing.reviewId, { type: 'thread.updated', reviewId: existing.reviewId, thread });
    return c.json({ thread });
  });

  /** Comment → (threadId, reviewId), for the embedded agent's `react` tool ownership check (`agent/tools.ts`). */
  app.get('/api/comments/:id', async (c) => {
    const commentId = c.req.param('id');
    const threadId = await getCommentThreadId(deps.db, commentId);
    if (threadId === null) throw notFound(`comment ${commentId} not found`);
    const thread = await requireThread(deps, threadId);
    return c.json({ threadId, reviewId: thread.reviewId });
  });

  app.delete('/api/comments/:id', async (c) => {
    const commentId = c.req.param('id');
    const threadId = await getCommentThreadId(deps.db, commentId);
    if (threadId === null) throw notFound(`comment ${commentId} not found`);
    const existing = await requireThread(deps, threadId);
    if (existing.comments.length === 1) await cancelThreadRuns(deps, existing);
    const result = await deleteComment(deps.db, commentId);
    if (result === null) throw notFound(`comment ${commentId} not found`);
    if (result.threadDeleted) {
      dispatch(existing.reviewId, { type: 'thread.deleted', reviewId: existing.reviewId, threadId });
      return c.json({ threadId, thread: null });
    }
    const thread = await requireThread(deps, threadId);
    dispatch(existing.reviewId, { type: 'thread.updated', reviewId: existing.reviewId, thread });
    return c.json({ threadId, thread });
  });

  // --- revision / viewed ---

  app.post('/api/reviews/:id/revision', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const body = await parseBody(setRevisionBodySchema, c);
    const engine = await requireEngine(deps, id);
    if (!engine.availableRevisions().includes(body.revision)) {
      throw conflict(`revision "${body.revision}" is not available for this review right now`);
    }
    await setCurrentRevision(deps.db, id, body.revision);
    // No tick needed: every available revision's file list is kept warm in
    // the background (reviewEngine.ts), so switching is a cache read. The
    // engine's in-memory review row still needs to know the new choice
    // immediately, since it isn't reloaded from sqlite until the next tick.
    engine.setCurrentRevisionHint(body.revision);
    const state = await engine.getState();
    const list = engine.getFileList(body.revision);
    return c.json({ state, list });
  });

  // Archive is a DB status flag only — it never disposes the engine or
  // touches worktrees, and it never deletes or modifies threads, comments,
  // reading order, or viewed state. Reversible by posting `open` again.
  app.post('/api/reviews/:id/status', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const body = await parseBody(setReviewStatusBodySchema, c);
    const review = await setStatus(deps.db, id, body.status);
    bus.changed('home');
    return c.json({ review });
  });

  app.post('/api/reviews/:id/viewed', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const body = await parseBody(markViewedBodySchema, c);
    const engine = await requireEngine(deps, id);
    const blobSha = body.blobSha ?? engine.getFileList().files.find((f) => f.path === body.path)?.newBlob;
    if (blobSha === undefined) throw notFound(`no current blob for path "${body.path}"`);

    if (body.viewed) {
      await markViewed(deps.db, id, body.path, blobSha);
    } else {
      await unmarkViewed(deps.db, id, body.path, blobSha);
    }
    bus.changed('home');
    return c.json({ ok: true as const });
  });

  app.post('/api/reviews/:id/viewed/all', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const body = await parseBody(setAllViewedBodySchema, c);
    const engine = await requireEngine(deps, id);
    for (const file of engine.getFileList().files) {
      if (body.viewed) await markViewed(deps.db, id, file.path, file.newBlob);
      else await unmarkViewed(deps.db, id, file.path, file.newBlob);
    }
    bus.changed('home');
    return c.json({ ok: true as const });
  });

  // --- runs ---

  app.get('/api/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = await getRun(deps.db, id);
    if (run === null) throw notFound(`run ${id} not found`);
    const events = await listEvents(deps.db, id);
    return c.json({ run, events: events.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload })) });
  });

  app.post('/api/runs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const existing = await getRun(deps.db, id);
    if (existing === null) throw notFound(`run ${id} not found`);
    const run = await cancelRun({ db: deps.db, invoke: deps.invoke, emit: (e) => dispatch(existing.reviewId, e) }, id);
    return c.json({ run: run ?? existing });
  });

  return app;
}
