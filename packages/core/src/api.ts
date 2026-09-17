/**
 * The HTTP contract (§10), imported by the server, the web app, and the CLI.
 *
 * Each entry carries its method, a path builder, and zod schemas for body and
 * response — so renaming a route or changing a payload is a compile error in
 * three packages rather than a runtime 404.
 */
import { z } from 'zod';
import {
  fileContentsSchema,
  filePatchSchema,
} from './domain/diff.ts';
import { fileListSchema, revisionSchema, reviewStateSchema } from './domain/files.ts';
import {
  agentRunSchema,
  branchSchema,
  meSchema,
  pullSchema,
  readingOrderPlanSchema,
  readingOrderSchema,
  repoSchema,
  reviewSchema,
  reviewStatusSchema,
  reviewSummarySchema,
  threadSchema,
} from './domain/review.ts';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      'not_found',
      'bad_request',
      'conflict',
      'unauthorized',
      'git_error',
      'internal',
    ]),
    message: z.string(),
    /** Actionable next step, e.g. the exact `git worktree repair` command (§4). */
    hint: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// --- request bodies ---

export const addRepoBodySchema = z.object({ path: z.string().min(1) });
export const createReviewBodySchema = z.object({
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  base: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  /**
   * Status for a review this call creates. An existing review at the same
   * identity is returned as-is, whatever its status. The web UI opens as
   * `draft` (look first, "Start review" later); the CLI defaults to `open`.
   */
  status: z.enum(['draft', 'open']).default('open'),
});
export const setRevisionBodySchema = z.object({ revision: revisionSchema });
export const markViewedBodySchema = z.object({
  path: z.string().min(1),
  /** Omitted means "the current blob for that path". */
  blobSha: z.string().optional(),
  viewed: z.boolean().default(true),
});
export const createThreadBodySchema = z.object({
  path: z.string().min(1),
  side: z.enum(['old', 'new']),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  bodyMd: z.string().min(1),
  /** Post the comment, then immediately ask an agent to reply (Cmd+Enter). */
  askAgent: z.boolean().default(false),
});
export const replyBodySchema = z.object({
  bodyMd: z.string().min(1),
  author: z.enum(['user', 'agent']).default('user'),
  agentRunId: z.string().optional(),
  askAgent: z.boolean().default(false),
});
export const generateReadingOrderBodySchema = z.object({});
export const setReviewStatusBodySchema = z.object({ status: reviewStatusSchema });

// A monorepo can have thousands of remote branches — `filter` and `limit`
// keep the response bounded rather than dumping the whole ref namespace.
export const listBranchesQuerySchema = z.object({
  filter: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export const listReviewsQuerySchema = z.object({
  /** Omitted means every status — archived reviews included. */
  status: reviewStatusSchema.optional(),
  /** `'true'` bypasses the server's short-lived `gh` cache for PR titles, CI, and diff sizes. */
  refresh: z.enum(['true', 'false']).optional(),
});
export const listPullsQuerySchema = z.object({
  /** `'true'` bypasses the server's short-lived `gh` cache. */
  refresh: z.enum(['true', 'false']).optional(),
});

// --- responses ---

export const reviewDetailSchema = z.object({
  review: reviewSchema,
  repo: repoSchema,
  state: reviewStateSchema,
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

export const feedbackSchema = z.object({
  markdown: z.string(),
});

const noContent = z.object({ ok: z.literal(true) });

/**
 * `P` is a type parameter rather than a fixed `(...args: never[]) => string` so
 * each route keeps its own path signature: `getReview.path` is `(id: string)`,
 * and calling it with the wrong number or type of segments is a compile error
 * in the client rather than a cast at the call site.
 */
type PathFn = (...args: never[]) => string;

type RouteDef<
  P extends PathFn,
  B extends z.ZodTypeAny | undefined,
  Q extends z.ZodTypeAny | undefined,
  R extends z.ZodTypeAny,
> = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: P;
  readonly body: B;
  /** Query-string schema, so `?rev=` and `?unresolved=` are typed too. */
  readonly query: Q;
  readonly response: R;
};

const def = <
  P extends PathFn,
  B extends z.ZodTypeAny | undefined,
  Q extends z.ZodTypeAny | undefined,
  R extends z.ZodTypeAny,
>(
  d: RouteDef<P, B, Q, R>,
): RouteDef<P, B, Q, R> => d;

export const api = {
  listRepos: def({
    method: 'GET',
    path: () => '/api/repos',
    body: undefined,
    query: undefined,
    response: z.object({ repos: z.array(repoSchema) }),
  }),
  addRepo: def({
    method: 'POST',
    path: () => '/api/repos',
    body: addRepoBodySchema,
    query: undefined,
    response: z.object({ repo: repoSchema }),
  }),
  listBranches: def({
    method: 'GET',
    path: (repoId: string) => `/api/repos/${encodeURIComponent(repoId)}/branches`,
    body: undefined,
    query: listBranchesQuerySchema,
    response: z.object({ branches: z.array(branchSchema) }),
  }),
  listPulls: def({
    method: 'GET',
    path: (repoId: string) => `/api/repos/${encodeURIComponent(repoId)}/pulls`,
    body: undefined,
    query: listPullsQuerySchema,
    response: z.object({ available: z.boolean(), pulls: z.array(pullSchema) }),
  }),
  me: def({
    method: 'GET',
    path: () => '/api/me',
    body: undefined,
    query: undefined,
    response: meSchema,
  }),
  listReviews: def({
    method: 'GET',
    path: () => '/api/reviews',
    body: undefined,
    query: listReviewsQuerySchema,
    response: z.object({ reviews: z.array(reviewSchema), summaries: z.array(reviewSummarySchema) }),
  }),
  createReview: def({
    method: 'POST',
    path: () => '/api/reviews',
    body: createReviewBodySchema,
    query: undefined,
    response: reviewDetailSchema,
  }),
  getReview: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: reviewDetailSchema,
  }),
  getFiles: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/files`,
    body: undefined,
    /** Omitted means the review's current revision. */
    query: z.object({ rev: revisionSchema.optional() }),
    response: z.object({
      list: fileListSchema,
      viewed: z.array(z.object({ path: z.string(), blobSha: z.string() })),
    }),
  }),
  getDiff: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/diff`,
    body: undefined,
    query: z.object({ path: z.string().min(1), rev: revisionSchema.optional() }),
    response: z.object({ patch: filePatchSchema }),
  }),
  getContents: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/contents`,
    body: undefined,
    query: z.object({ path: z.string().min(1), rev: revisionSchema.optional() }),
    response: z.object({ contents: fileContentsSchema }),
  }),
  getReadingOrder: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/reading-order`,
    body: undefined,
    query: undefined,
    response: z.object({ readingOrder: readingOrderSchema.nullable() }),
  }),
  setReadingOrder: def({
    method: 'PUT',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/reading-order`,
    body: readingOrderPlanSchema,
    query: undefined,
    response: z.object({ readingOrder: readingOrderSchema }),
  }),
  generateReadingOrder: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/reading-order/generate`,
    body: generateReadingOrderBodySchema,
    query: undefined,
    response: z.object({ run: agentRunSchema }),
  }),
  listThreads: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/threads`,
    body: undefined,
    /**
     * `rev` scopes the returned line positions to a revision other than the
     * review's persisted current one — projected at read time, never
     * persisted (SPEC §5 "Threads across snapshots"). Omitted means the
     * persisted revision's stored positions, as before.
     */
    query: z.object({ status: z.enum(['open', 'resolved']).optional(), rev: revisionSchema.optional() }),
    response: z.object({ threads: z.array(threadSchema) }),
  }),
  createThread: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/threads`,
    body: createThreadBodySchema,
    query: undefined,
    response: z.object({ thread: threadSchema, run: agentRunSchema.nullable() }),
  }),
  getThread: def({
    method: 'GET',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: z.object({ thread: threadSchema }),
  }),
  reply: def({
    method: 'POST',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}/replies`,
    body: replyBodySchema,
    query: undefined,
    response: z.object({ thread: threadSchema, run: agentRunSchema.nullable() }),
  }),
  resolveThread: def({
    method: 'POST',
    path: (id: string) => `/api/threads/${encodeURIComponent(id)}/resolve`,
    body: z.object({ resolved: z.boolean().default(true) }),
    query: undefined,
    response: z.object({ thread: threadSchema }),
  }),
  feedback: def({
    method: 'GET',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/feedback`,
    body: undefined,
    query: z.object({
      format: z.literal('markdown').optional(),
      unresolved: z.enum(['true', 'false']).optional(),
    }),
    response: feedbackSchema,
  }),
  setRevision: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/revision`,
    body: setRevisionBodySchema,
    query: undefined,
    // `list` rides along with the switch response — the target revision's
    // snapshot is already warm (kept fresh in the background), so this is a
    // cache read, not a second round trip via GET /files.
    response: z.object({ state: reviewStateSchema, list: fileListSchema }),
  }),
  setReviewStatus: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/status`,
    body: setReviewStatusBodySchema,
    query: undefined,
    response: z.object({ review: reviewSchema }),
  }),
  markViewed: def({
    method: 'POST',
    path: (id: string) => `/api/reviews/${encodeURIComponent(id)}/viewed`,
    body: markViewedBodySchema,
    query: undefined,
    response: noContent,
  }),
  getRun: def({
    method: 'GET',
    path: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
    body: undefined,
    query: undefined,
    response: z.object({
      run: agentRunSchema,
      events: z.array(
        z.object({ seq: z.number().int(), type: z.string(), payload: z.unknown() }),
      ),
    }),
  }),
} as const;

export type Api = typeof api;
export type ApiOperation = keyof Api;

export type BodyOf<K extends ApiOperation> = Api[K]['body'] extends z.ZodTypeAny
  ? z.input<Api[K]['body']>
  : never;
export type QueryOf<K extends ApiOperation> = Api[K]['query'] extends z.ZodTypeAny
  ? z.input<Api[K]['query']>
  : never;
export type PathArgsOf<K extends ApiOperation> = Parameters<Api[K]['path']>;
export type ResponseOf<K extends ApiOperation> = z.output<Api[K]['response']>;

export const DEFAULT_PORT = 7317;
export const DEFAULT_HOST = '127.0.0.1';
