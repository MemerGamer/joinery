/**
 * The WS contract (Transport).
 *
 * Clients `watch` the topics they show and receive only those topics' events:
 *
 *   home          — anything a Homebase card shows (`topic.changed`)
 *   repo:<id>     — the repo's open pulls (`topic.changed`)
 *   review:<id>   — one review: its live file list and state, threads, runs,
 *                   and `topic.changed` when the engine's stored state moved
 *
 * `topic.changed` carries no data: the client re-reads through the same API a
 * fresh load uses. The review window's live events still carry their payload
 * (the *current* file list, which the client set-diffs against the one it
 * holds). Reconnect is "watch again".
 */
import { z } from 'zod';
import { divergenceSchema, fileListSchema, reviewStateSchema } from './domain/files.ts';
import { agentRunSchema, threadSchema } from './domain/review.ts';

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('files.changed'),
    reviewId: z.string(),
    list: fileListSchema,
  }),
  z.object({
    type: z.literal('root.rebound'),
    reviewId: z.string(),
    state: reviewStateSchema,
  }),
  z.object({
    type: z.literal('remote.moved'),
    reviewId: z.string(),
    divergence: divergenceSchema,
    /** True when the merge-base moved, which invalidates the whole diff. */
    baseMoved: z.boolean(),
  }),
  z.object({
    type: z.literal('thread.relocated'),
    reviewId: z.string(),
    threads: z.array(threadSchema),
  }),
  z.object({
    type: z.literal('thread.created'),
    reviewId: z.string(),
    thread: threadSchema,
  }),
  z.object({
    type: z.literal('thread.updated'),
    reviewId: z.string(),
    thread: threadSchema,
  }),
  z.object({
    type: z.literal('thread.deleted'),
    reviewId: z.string(),
    threadId: z.string(),
  }),
  z.object({
    type: z.literal('reading_order.updated'),
    reviewId: z.string(),
  }),
  z.object({
    type: z.literal('run.started'),
    reviewId: z.string(),
    run: agentRunSchema,
  }),
  /** The agent started a tool call: a short human label for the UI's activity line. */
  z.object({
    type: z.literal('run.activity'),
    reviewId: z.string(),
    runId: z.string(),
    label: z.string(),
  }),
  z.object({
    type: z.literal('run.ended'),
    reviewId: z.string(),
    run: agentRunSchema,
  }),
  z.object({
    type: z.literal('repo.unavailable'),
    repoId: z.string(),
    reason: z.string(),
  }),
  /**
   * What `topic` covers changed. Carries no data: the client re-reads it.
   * `version` only ever grows per topic (until the server restarts), so a
   * client can skip one older than an event it already handled.
   */
  z.object({
    type: z.literal('topic.changed'),
    topic: z.string(),
    version: z.number().int(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** `home`, `repo:<id>` or `review:<id>`. */
export const topicSchema = z.union([
  z.literal('home'),
  z.string().regex(/^repo:.+$/),
  z.string().regex(/^review:.+$/),
]);
export type Topic = z.infer<typeof topicSchema>;

export const reviewTopic = (reviewId: string): Topic => `review:${reviewId}`;
export const repoTopic = (repoId: string): Topic => `repo:${repoId}`;

export const clientMessageSchema = z.discriminatedUnion('type', [
  /**
   * Start receiving `topic`'s events. Watching `review:<id>` also keeps the
   * review's live worker running and sends its current file list and state
   * back at once. Watching again is a no-op.
   */
  z.object({ type: z.literal('watch'), topic: topicSchema }),
  z.object({ type: z.literal('unwatch'), topic: topicSchema }),
  /** The review's window gained focus: the engine re-polls its repo now. */
  z.object({ type: z.literal('focus'), reviewId: z.string() }),
  z.object({ type: z.literal('blur'), reviewId: z.string() }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
