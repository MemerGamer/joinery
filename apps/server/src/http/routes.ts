/**
 * Every route, driven by the `api` map from
 * `@joinery/core`: validate params through each route's `body`/`query`
 * schema, return exactly its `response` shape.
 */
import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import {
  addRepoBodySchema,
  askAgentBodySchema,
  createReviewBodySchema,
  createThreadBodySchema,
  generateReadingOrderBodySchema,
  listDirsQuerySchema,
  listBranchesQuerySchema,
  listPullsQuerySchema,
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
import {
  appendReply,
  createReview,
  createThread,
  findReviewByBranch,
  findReviewByPinnedSha,
  getCommentThreadId,
  getLatestReadingOrder,
  getRepoById,
  getRepoByPath,
  getReview,
  getRun,
  getThreadWithComments,
  listEvents,
  listRepos,
  listReviews,
  listThreadsByReview,
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
import { buildReviewSummaries, getMeCached } from '../homebase.ts';
import { getPullsCached } from '../pullsCache.ts';
import type { StoredCacheDeps } from '../storedCache.ts';
import {
  canonicalizePath,
  defaultBranch as gitDefaultBranch,
  getFileContents,
  getFilePatch,
  listBranches,
  remoteIdentity,
  resolvePr,
  showToplevel,
} from '../git/index.ts';
import type { EngineRegistry } from '../engine/index.ts';
import { captureContext } from '../engine/anchor.ts';
import { projectThreads } from '../engine/threadProjection.ts';
import { generateReadingOrder, requestThreadReply } from '../agent/runs.ts';
import type { Invoke } from '../agent/tools.ts';
import { resolveRunCwd } from '../agent/worktree.ts';
import { badRequest, conflict, notFound } from './errors.ts';
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
const feedbackQuerySchema = z.object({
  format: z.literal('markdown').optional(),
  unresolved: z.enum(['true', 'false']).optional(),
});
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

async function requireThread(deps: RoutesDeps, threadId: string): Promise<Thread> {
  const thread = await getThreadWithComments(deps.db, threadId);
  if (thread === null) throw notFound(`thread ${threadId} not found`);
  return thread;
}

export function buildRoutes(deps: RoutesDeps): Hono {
  const app = new Hono();
  const dispatch = (reviewId: string, event: ServerEvent): void => deps.registry.dispatch(reviewId, event);
  // A background git/`gh` refresh that changed what Homebase shows tells it to refetch.
  const homeDeps: StoredCacheDeps = { db: deps.db, onUpdated: () => deps.registry.notifyHome(null) };

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
    } catch {
      throw badRequest(`path does not exist: ${body.path}`);
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

    const repo = await upsertRepo(deps.db, {
      rootPath,
      remoteOwner: identity.owner,
      remoteName: identity.name,
      defaultBranch: branch,
    });
    return c.json({ repo }, 201);
  });

  // Server-side folder browsing for the add-repo picker.
  app.get('/api/fs/dirs', async (c) => {
    const query = parseQuery(listDirsQuerySchema, c);
    return c.json(await listDirs(query.path, query.hidden !== undefined));
  });

  app.get('/api/me', async (c) => {
    return c.json(await getMeCached(homeDeps));
  });

  // --- discovery: branches and PRs for a registered repo, so the web UI can
  // open any of them, not just ones added via the CLI ---

  app.get('/api/repos/:id/branches', async (c) => {
    const id = c.req.param('id');
    const repo = await getRepoById(deps.db, id);
    if (repo === null) throw notFound(`repo ${id} not found`);
    const query = parseQuery(listBranchesQuerySchema, c);
    const rawBranches = await listBranches({
      cwd: repo.rootPath,
      ...(query.filter === undefined ? {} : { filter: query.filter }),
      limit: query.limit ?? 50,
      defaultBranch: repo.defaultBranch,
    });
    const branches = await Promise.all(
      rawBranches.map(async (branch) => {
        const existing = await findReviewByBranch(deps.db, repo.id, branch.name);
        return { ...branch, reviewId: existing?.id ?? null, reviewStatus: existing?.status ?? null };
      }),
    );
    return c.json({ branches });
  });

  app.get('/api/repos/:id/pulls', async (c) => {
    const id = c.req.param('id');
    const repo = await getRepoById(deps.db, id);
    if (repo === null) throw notFound(`repo ${id} not found`);
    const query = parseQuery(listPullsQuerySchema, c);
    const result = await getPullsCached(homeDeps, repo, { refresh: query.refresh === 'true' });
    const pulls = await Promise.all(
      result.pulls.map(async (pull) => {
        const existing = await findReviewByBranch(deps.db, repo.id, pull.headRefName);
        return { ...pull, reviewId: existing?.id ?? null, reviewStatus: existing?.status ?? null };
      }),
    );
    return c.json({ available: result.available, pulls });
  });

  // --- reviews ---

  app.get('/api/reviews', async (c) => {
    const query = parseQuery(listReviewsQuerySchema, c);
    const reviews = await listReviews(deps.db, query.status === undefined ? undefined : { status: query.status });
    const summaries = await buildReviewSummaries(homeDeps, reviews, { refresh: query.refresh === 'true' });
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

    // A bare `prNumber` (no branch/sha) resolves via `gh` to the PR's real
    // `(headRefName, baseRefName)` before falling into the normal
    // branch/sha identity logic below. A PR review is then identified as
    // `(repo, headRefName)` with `prNumber` set — the SAME identity as a
    // branch review, so `findReviewByBranch`'s dedupe already
    // handles "open PR #123 twice" without any PR-specific lookup table.
    // Fork PRs are out of scope; same-repo PRs only.
    let branch = body.branch;
    let base = body.base;
    if (branch === undefined && body.sha === undefined) {
      if (body.prNumber === undefined) {
        throw badRequest('one of branch or sha (or prNumber, resolved via gh) is required');
      }
      const resolved = await resolvePr(body.prNumber, { cwd: repo.rootPath });
      if (resolved === null) {
        throw badRequest(
          `could not resolve PR #${String(body.prNumber)} via gh`,
          'Check that `gh` is installed, authenticated (`gh auth status`), and the PR exists in this repo.',
        );
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
    // Opening the review marks its unread-agent-replies window read:
    // must happen after the response is built, so this open is measured
    // against the *previous* `last_opened_at`, not the one it just set.
    await touchOpened(deps.db, id);
    return c.json({ review, repo, state });
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
    const readingOrder = await getLatestReadingOrder(deps.db, id, currentPaths);
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
    await parseBody(generateReadingOrderBodySchema, c);
    const engine = await requireEngine(deps, id);
    const files = engine.getFileList().files;
    const cwd = await resolveRunCwd({ db: deps.db }, review, engine);
    const run = await generateReadingOrder({ db: deps.db, invoke: deps.invoke, emit: (e) => dispatch(id, e) }, id, {
      cwd,
      files,
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
      bodyMd: body.bodyMd,
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

  app.post('/api/threads/:id/replies', async (c) => {
    const threadId = c.req.param('id');
    const thread = await requireThread(deps, threadId);
    const body = await parseBody(replyBodySchema, c);

    await appendReply(deps.db, {
      threadId,
      author: body.author,
      bodyMd: body.bodyMd,
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

  // --- feedback ---

  app.get('/api/reviews/:id/feedback', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
    const query = parseQuery(feedbackQuerySchema, c);
    const unresolvedOnly = query.unresolved === 'true';
    const threads = unresolvedOnly
      ? await listThreadsByReview(deps.db, id, { unresolvedOnly: true })
      : await listThreadsByReview(deps.db, id);

    const markdown = renderFeedbackMarkdown(threads);
    return c.json({ markdown });
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

  return app;
}

function renderFeedbackMarkdown(threads: Thread[]): string {
  if (threads.length === 0) return '_No comments._\n';
  const byPath = new Map<string, Thread[]>();
  for (const t of threads) {
    const list = byPath.get(t.path) ?? [];
    list.push(t);
    byPath.set(t.path, list);
  }

  const lines: string[] = [];
  for (const [path, pathThreads] of [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`## ${path}`, '');
    for (const t of pathThreads) {
      const rangeLabel = t.startLine === t.endLine ? `L${String(t.startLine)}` : `L${String(t.startLine)}-${String(t.endLine)}`;
      const status = t.status === 'resolved' ? ' (resolved)' : '';
      const outdated = t.outdated ? ' _(outdated)_' : '';
      lines.push(`### ${rangeLabel}${status}${outdated}`, '');
      for (const comment of t.comments) {
        lines.push(`**${comment.author}:** ${comment.bodyMd}`, '');
      }
    }
  }
  return lines.join('\n');
}
