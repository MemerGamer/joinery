/**
 * The single source of truth for every table.
 *
 * Drizzle is used as a typed query builder, not an ORM: no relations API, no
 * lazy loading, no active records. Migrations are hand-reviewed SQL under
 * `apps/server/migrations` — `drizzle-kit generate` produces them, a human
 * reads them, and the server applies them in order. Nothing auto-pushes.
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch())`;

/** A registered local clone. `root_path` is always a realpath (see canonicalizePath). */
export const repo = sqliteTable(
  'repo',
  {
    id: text('id').primaryKey(),
    rootPath: text('root_path').notNull(),
    remoteOwner: text('remote_owner'),
    remoteName: text('remote_name'),
    defaultBranch: text('default_branch').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('repo_root_path_idx').on(t.rootPath)],
);

/**
 * A review is `(repo, branch)`. A detached review starts as `(repo, pinned_sha)`
 * with a null branch and adopts one later, in place.
 *
 * Root attachment is resolved from git on every tick and is not stored
 * here — `ReviewState.root.attachedPath` is the live value.
 */
export const review = sqliteTable(
  'review',
  {
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repo.id, { onDelete: 'cascade' }),
    branch: text('branch'),
    pinnedSha: text('pinned_sha'),
    baseRef: text('base_ref').notNull(),
    prNumber: integer('pr_number'),
    /**
     * 'working' | 'head' | 'pr' — validated by `revisionSchema` at the
     * boundary. NULL means the user has never chosen: the default applies
     * (working when attached, else head) instead of a stored value.
     */
    currentRevision: text('current_revision'),
    /** PR head SHA last rendered, for the "changes since you last looked" view. */
    lastSeenPrSha: text('last_seen_pr_sha'),
    /** Unix seconds the review was last opened via `GET /api/reviews/:id`; null means never ("unread agent replies"). */
    lastOpenedAt: integer('last_opened_at'),
    status: text('status').notNull().default('open'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('review_repo_branch_idx').on(t.repoId, t.branch),
    index('review_repo_idx').on(t.repoId),
  ],
);

/**
 * A cache, not review state. Keyed by `(repo, sha)`; deleting every row costs
 * one rebuild before the next agent run.
 */
export const agentWorktree = sqliteTable(
  'agent_worktree',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repo.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    lastUsedAt: integer('last_used_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.sha] })],
);

/** Regenerating supersedes rather than replaces: old versions are retained. */
export const readingOrder = sqliteTable(
  'reading_order',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => review.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    agentRunId: text('agent_run_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('reading_order_review_version_idx').on(t.reviewId, t.version)],
);

export const step = sqliteTable(
  'step',
  {
    id: text('id').primaryKey(),
    readingOrderId: text('reading_order_id')
      .notNull()
      .references(() => readingOrder.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    title: text('title').notNull(),
    explanationMd: text('explanation_md').notNull().default(''),
  },
  (t) => [uniqueIndex('step_order_idx').on(t.readingOrderId, t.idx)],
);

export const stepFile = sqliteTable(
  'step_file',
  {
    stepId: text('step_id')
      .notNull()
      .references(() => step.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    path: text('path').notNull(),
    noteMd: text('note_md'),
  },
  (t) => [primaryKey({ columns: [t.stepId, t.idx] })],
);

/**
 * Keyed by blob SHA, so a changed blob simply fails to match and the check
 * clears itself. There is no invalidation code.
 */
export const fileViewed = sqliteTable(
  'file_viewed',
  {
    reviewId: text('review_id')
      .notNull()
      .references(() => review.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    blobSha: text('blob_sha').notNull(),
    viewedAt: integer('viewed_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.path, t.blobSha] })],
);

export const thread = sqliteTable(
  'thread',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => review.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** 'old' | 'new' */
    side: text('side').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    anchorBlobSha: text('anchor_blob_sha').notNull(),
    /** Hash of ±3 context lines, used to relocate the thread when content moves. */
    anchorContextHash: text('anchor_context_hash').notNull(),
    /** The code as captured when the thread was written, shown when re-anchoring fails. */
    anchorContext: text('anchor_context').notNull().default(''),
    /** 'open' | 'resolved' */
    status: text('status').notNull().default('open'),
    outdated: integer('outdated', { mode: 'boolean' }).notNull().default(false),
    /** Set when the anchored lines changed after the thread was written. */
    changedSinceComment: integer('changed_since_comment', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('thread_review_path_idx').on(t.reviewId, t.path)],
);

export const comment = sqliteTable(
  'comment',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    /** 'user' | 'agent' */
    author: text('author').notNull(),
    bodyMd: text('body_md').notNull(),
    agentRunId: text('agent_run_id'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('comment_thread_idx').on(t.threadId, t.createdAt)],
);

/**
 * One row per `(comment, actor, kind)`. Reactions carry no identity of their
 * own — a user toggling one off simply deletes the row.
 */
export const reaction = sqliteTable(
  'reaction',
  {
    commentId: text('comment_id')
      .notNull()
      .references(() => comment.id, { onDelete: 'cascade' }),
    /** 'user' | 'agent' */
    actor: text('actor').notNull(),
    /** One of `reactionKindSchema`. */
    kind: text('kind').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.actor, t.kind] }),
    index('reaction_comment_idx').on(t.commentId),
  ],
);

export const agentRun = sqliteTable(
  'agent_run',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => review.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => thread.id, { onDelete: 'cascade' }),
    /** 'reading_order' | 'thread_reply' */
    kind: text('kind').notNull(),
    /** 'pending' | 'running' | 'done' | 'error' | 'cancelled' */
    status: text('status').notNull().default('pending'),
    sessionId: text('session_id'),
    /** JSON `{resume, resumeSessionAt, turnCount}` so runs survive a restart. */
    resumeCursor: text('resume_cursor'),
    startedAt: integer('started_at').notNull().default(now),
    endedAt: integer('ended_at'),
    error: text('error'),
  },
  (t) => [index('agent_run_review_idx').on(t.reviewId)],
);

/** Every SDK message, so the work-in-progress UI is replayable across reloads. */
export const agentEvent = sqliteTable(
  'agent_event',
  {
    runId: text('run_id')
      .notNull()
      .references(() => agentRun.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    /** JSON. */
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const schema = {
  repo,
  review,
  agentWorktree,
  readingOrder,
  step,
  stepFile,
  fileViewed,
  thread,
  comment,
  reaction,
  agentRun,
  agentEvent,
};

export type RepoRow = typeof repo.$inferSelect;
export type ReviewRow = typeof review.$inferSelect;
export type AgentWorktreeRow = typeof agentWorktree.$inferSelect;
export type ReadingOrderRow = typeof readingOrder.$inferSelect;
export type StepRow = typeof step.$inferSelect;
export type StepFileRow = typeof stepFile.$inferSelect;
export type FileViewedRow = typeof fileViewed.$inferSelect;
export type ThreadRow = typeof thread.$inferSelect;
export type CommentRow = typeof comment.$inferSelect;
export type ReactionRow = typeof reaction.$inferSelect;
export type AgentRunRow = typeof agentRun.$inferSelect;
export type AgentEventRow = typeof agentEvent.$inferSelect;
