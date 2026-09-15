/**
 * Every route in SPEC §10's table, driven by the `api` map from
 * `@review/core`: validate params through each route's `body`/`query`
 * schema, return exactly its `response` shape.
 */
import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import {
  addRepoBodySchema,
  createReviewBodySchema,
  createThreadBodySchema,
  generateReadingOrderBodySchema,
  markViewedBodySchema,
  readingOrderPlanSchema,
  replyBodySchema,
  revisionSchema,
  setRevisionBodySchema,
  NULL_BLOB,
  type ServerEvent,
  type Thread,
} from '@review/core';
import { z } from 'zod';
import {
  appendReply,
  createReview,
  createThread,
  findReviewByBranch,
  findReviewByPinnedSha,
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
  unmarkViewed,
  unresolveThread,
  upsertRepo,
  writeReadingOrderPlan,
  type Db,
} from '../db/index.ts';
import {
  canonicalizePath,
  defaultBranch as gitDefaultBranch,
  getFileContents,
  getFilePatch,
  remoteIdentity,
  showToplevel,
} from '../git/index.ts';
import type { EngineRegistry } from '../engine/index.ts';
import { captureContext } from '../engine/anchor.ts';
import { generateReadingOrder, requestThreadReply } from '../agent/runs.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import { parseBody, parseQuery } from './validate.ts';

export type RoutesDeps = {
  readonly db: Db;
  readonly registry: EngineRegistry;
};

const diffQuerySchema = z.object({ path: z.string().min(1), rev: z.enum(['working', 'head', 'pr']).optional() });
const filesQuerySchema = z.object({ rev: revisionSchema.optional() });
const threadsQuerySchema = z.object({ status: z.enum(['open', 'resolved']).optional() });
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
        'Pass a full path, e.g. `review repos add "$(pwd)"`.',
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

  // --- reviews ---

  app.get('/api/reviews', async (c) => {
    const reviews = await listReviews(deps.db);
    return c.json({ reviews });
  });

  app.post('/api/reviews', async (c) => {
    const body = await parseBody(createReviewBodySchema, c);

    let repo = body.repoId !== undefined ? await getRepoById(deps.db, body.repoId) : null;
    if (repo === null && body.repoPath !== undefined) {
      const canonical = await canonicalizePath(body.repoPath);
      repo = await getRepoByPath(deps.db, canonical);
    }
    if (repo === null) throw badRequest('repoId or a registered repoPath is required');

    if (body.branch === undefined && body.sha === undefined) {
      throw badRequest('one of branch or sha is required');
    }

    let review =
      body.branch !== undefined
        ? await findReviewByBranch(deps.db, repo.id, body.branch)
        : body.sha !== undefined
          ? await findReviewByPinnedSha(deps.db, repo.id, body.sha)
          : null;

    if (review === null) {
      review = await createReview(deps.db, {
        repoId: repo.id,
        branch: body.branch ?? null,
        pinnedSha: body.sha ?? null,
        baseRef: body.base ?? repo.defaultBranch,
        prNumber: body.prNumber ?? null,
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
    await requireReview(deps, id);
    await parseBody(generateReadingOrderBodySchema, c);
    const engine = await requireEngine(deps, id);
    const renderCtx = engine.getRenderContext();
    const files = engine.getFileList().files;
    const run = await generateReadingOrder({ db: deps.db, emit: (e) => dispatch(id, e) }, id, {
      cwd: renderCtx.cwd,
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
    return c.json({ threads });
  });

  app.post('/api/reviews/:id/threads', async (c) => {
    const id = c.req.param('id');
    await requireReview(deps, id);
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

    const run = body.askAgent ? await requestThreadReply({ db: deps.db, emit: (e) => dispatch(id, e) }, id, thread.id) : null;
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

    const run = body.askAgent
      ? await requestThreadReply({ db: deps.db, emit: (e) => dispatch(thread.reviewId, e) }, thread.reviewId, threadId)
      : null;
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
    const stateBefore = await engine.getState();
    if (!stateBefore.availableRevisions.includes(body.revision)) {
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
