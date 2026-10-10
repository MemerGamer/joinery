/**
 * The WS contract (Transport).
 *
 * The server sends the *current* file list; the client set-diffs it against the
 * one it holds. There is no delta protocol, no snapshot handshake, and no
 * version negotiation — reconnect is "send me the list".
 */
import { z } from 'zod';
import { divergenceSchema, fileListSchema, revisionSchema, reviewStateSchema } from './domain/files.ts';
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
    type: z.literal('reading_order.updated'),
    reviewId: z.string(),
  }),
  z.object({
    type: z.literal('run.started'),
    reviewId: z.string(),
    run: agentRunSchema,
  }),
  /** Token-level streaming from `includePartialMessages`. */
  z.object({
    type: z.literal('run.delta'),
    reviewId: z.string(),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    /** The SDK message type, kept opaque so the UI can render what it knows. */
    messageType: z.string(),
    payload: z.unknown(),
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
   * Something Homebase shows changed (a review created, archived, commented
   * on, run, ...) — sent to connections that sent `subscribeHome`. Carries
   * no data: Homebase just refetches its summaries. `reviewId` is set when
   * the change is known to concern one review.
   */
  z.object({
    type: z.literal('reviews.changed'),
    reviewId: z.string().nullable(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];

export const clientMessageSchema = z.discriminatedUnion('type', [
  /**
   * Start receiving events for a review, and get its file list back. `revision`
   * scopes which revision this connection cares about: `files.changed` for any
   * other revision is filtered out server-side, so two tabs on the same review
   * can each watch a different revision independently. Sending `subscribe`
   * again for a review already subscribed to just updates the revision filter
   * (used when switching what this tab is looking at).
   */
  z.object({ type: z.literal('subscribe'), reviewId: z.string(), revision: revisionSchema.optional() }),
  z.object({ type: z.literal('unsubscribe'), reviewId: z.string() }),
  /** Window focus: the engine ticks and refetches the remote. */
  z.object({ type: z.literal('focus'), reviewId: z.string() }),
  z.object({ type: z.literal('blur'), reviewId: z.string() }),
  z.object({ type: z.literal('ping') }),
  /** Start/stop receiving `reviews.changed` (Homebase's live refresh). */
  z.object({ type: z.literal('subscribeHome') }),
  z.object({ type: z.literal('unsubscribeHome') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
