/**
 * The WS contract (§5, *Transport*).
 *
 * The server sends the *current* file list; the client set-diffs it against the
 * one it holds. There is no delta protocol, no snapshot handshake, and no
 * version negotiation — reconnect is "send me the list".
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
    type: z.literal('reading_order.updated'),
    reviewId: z.string(),
  }),
  z.object({
    type: z.literal('run.started'),
    reviewId: z.string(),
    run: agentRunSchema,
  }),
  /** Token-level streaming from `includePartialMessages` (§9). */
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
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];

export const clientMessageSchema = z.discriminatedUnion('type', [
  /** Start receiving events for a review, and get the current list back. */
  z.object({ type: z.literal('subscribe'), reviewId: z.string() }),
  z.object({ type: z.literal('unsubscribe'), reviewId: z.string() }),
  /** Window focus: the engine ticks and refetches the remote (§5). */
  z.object({ type: z.literal('focus'), reviewId: z.string() }),
  z.object({ type: z.literal('blur'), reviewId: z.string() }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
