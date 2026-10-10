/**
 * `thread` + `comment` — comment threads and anchoring.
 */
import { comment, thread } from '@review/core/db';
import type { Comment, Reaction, Thread, ThreadSide } from '@review/core';
import { commentId, threadId as newThreadId, threadSideSchema } from '@review/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import { narrowUnion } from './narrow.ts';
import { listReactionsForComments } from './reactions.ts';

const THREAD_STATUS = ['open', 'resolved'] as const;
const COMMENT_AUTHOR = ['user', 'agent'] as const;

function toComment(row: typeof comment.$inferSelect, reactions: Reaction[]): Comment {
  return {
    id: row.id,
    threadId: row.threadId,
    author: narrowUnion(row.author, COMMENT_AUTHOR, 'comment.author'),
    bodyMd: row.bodyMd,
    agentRunId: row.agentRunId,
    createdAt: row.createdAt,
    reactions,
  };
}

function toThread(row: typeof thread.$inferSelect, comments: Comment[]): Thread {
  return {
    id: row.id,
    reviewId: row.reviewId,
    path: row.path,
    side: narrowUnion(row.side, threadSideSchema.options, 'thread.side'),
    startLine: row.startLine,
    endLine: row.endLine,
    anchorBlobSha: row.anchorBlobSha,
    anchorContextHash: row.anchorContextHash,
    anchorContext: row.anchorContext,
    status: narrowUnion(row.status, THREAD_STATUS, 'thread.status'),
    outdated: row.outdated,
    changedSinceComment: row.changedSinceComment,
    createdAt: row.createdAt,
    comments,
  };
}

export type CreateThreadInput = {
  readonly reviewId: string;
  readonly path: string;
  readonly side: ThreadSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly anchorBlobSha: string;
  readonly anchorContextHash: string;
  readonly anchorContext: string;
  /** The thread's first comment. */
  readonly bodyMd: string;
  readonly author?: 'user' | 'agent';
  readonly agentRunId?: string | null;
};

/** Create a thread and its first comment in one transaction. */
export async function createThread(db: Db, input: CreateThreadInput): Promise<Thread> {
  return db.transaction((tx) => {
    const id = newThreadId();
    const threadRows = tx
      .insert(thread)
      .values({
        id,
        reviewId: input.reviewId,
        path: input.path,
        side: input.side,
        startLine: input.startLine,
        endLine: input.endLine,
        anchorBlobSha: input.anchorBlobSha,
        anchorContextHash: input.anchorContextHash,
        anchorContext: input.anchorContext,
      })
      .returning()
      .all();
    const threadRow = threadRows[0];
    if (threadRow === undefined) throw new Error('createThread: insert returned no row');

    const commentRows = tx
      .insert(comment)
      .values({
        id: commentId(),
        threadId: id,
        author: input.author ?? 'user',
        bodyMd: input.bodyMd,
        agentRunId: input.agentRunId ?? null,
      })
      .returning()
      .all();
    const commentRow = commentRows[0];
    if (commentRow === undefined) throw new Error('createThread: comment insert returned no row');

    return toThread(threadRow, [toComment(commentRow, [])]);
  });
}

async function loadComments(db: Db, threadIds: string[]): Promise<Map<string, Comment[]>> {
  const byThread = new Map<string, Comment[]>();
  if (threadIds.length === 0) return byThread;
  const rows = await db
    .select()
    .from(comment)
    .where(inArray(comment.threadId, threadIds))
    .orderBy(asc(comment.createdAt));
  const reactionsByComment = await listReactionsForComments(db, rows.map((r) => r.id));
  for (const row of rows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(toComment(row, reactionsByComment.get(row.id) ?? []));
    byThread.set(row.threadId, list);
  }
  return byThread;
}

export type ListThreadsOptions = {
  readonly unresolvedOnly?: boolean;
};

export async function listThreadsByReview(db: Db, reviewId: string, options: ListThreadsOptions = {}): Promise<Thread[]> {
  const where =
    options.unresolvedOnly === true
      ? and(eq(thread.reviewId, reviewId), eq(thread.status, 'open'))
      : eq(thread.reviewId, reviewId);

  const rows = await db.select().from(thread).where(where).orderBy(asc(thread.createdAt));
  const commentsByThread = await loadComments(db, rows.map((r) => r.id));
  return rows.map((row) => toThread(row, commentsByThread.get(row.id) ?? []));
}

export async function getThreadWithComments(db: Db, id: string): Promise<Thread | null> {
  const rows = await db.select().from(thread).where(eq(thread.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const commentsByThread = await loadComments(db, [row.id]);
  return toThread(row, commentsByThread.get(row.id) ?? []);
}

export type AppendReplyInput = {
  readonly threadId: string;
  readonly author: 'user' | 'agent';
  readonly bodyMd: string;
  readonly agentRunId?: string | null;
};

export async function appendReply(db: Db, input: AppendReplyInput): Promise<Comment> {
  const rows = await db
    .insert(comment)
    .values({
      id: commentId(),
      threadId: input.threadId,
      author: input.author,
      bodyMd: input.bodyMd,
      agentRunId: input.agentRunId ?? null,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('appendReply: insert returned no row');
  return toComment(row, []);
}

/** Comment → thread id, for routes that need to reach the thread (and its review) from a comment. */
export async function getCommentThreadId(db: Db, id: string): Promise<string | null> {
  const rows = await db.select({ threadId: comment.threadId }).from(comment).where(eq(comment.id, id)).limit(1);
  return rows[0]?.threadId ?? null;
}

async function setResolved(db: Db, id: string, resolved: boolean): Promise<Thread> {
  const rows = await db
    .update(thread)
    .set({ status: resolved ? 'resolved' : 'open' })
    .where(eq(thread.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`thread ${id} not found`);
  const commentsByThread = await loadComments(db, [row.id]);
  return toThread(row, commentsByThread.get(row.id) ?? []);
}

export const resolveThread = (db: Db, id: string): Promise<Thread> => setResolved(db, id, true);
export const unresolveThread = (db: Db, id: string): Promise<Thread> => setResolved(db, id, false);

export type ThreadAnchorUpdate = {
  readonly id: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly anchorBlobSha: string;
  readonly outdated: boolean;
  readonly changedSinceComment: boolean;
};

/** Bulk-update anchor fields after a re-anchor pass. */
export async function updateAnchors(db: Db, updates: readonly ThreadAnchorUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  await db.transaction((tx) => {
    for (const u of updates) {
      tx.update(thread)
        .set({
          startLine: u.startLine,
          endLine: u.endLine,
          anchorBlobSha: u.anchorBlobSha,
          outdated: u.outdated,
          changedSinceComment: u.changedSinceComment,
        })
        .where(eq(thread.id, u.id))
        .run();
    }
  });
}
