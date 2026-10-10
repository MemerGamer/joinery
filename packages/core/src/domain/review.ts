import { z } from 'zod';
import { revisionSchema } from './files.ts';

export const repoSchema = z.object({
  id: z.string(),
  rootPath: z.string(),
  remoteOwner: z.string().nullable(),
  remoteName: z.string().nullable(),
  defaultBranch: z.string(),
  createdAt: z.number().int(),
});
export type Repo = z.infer<typeof repoSchema>;

/**
 * `draft`: opened from the UI to look at, not yet claimed as a review —
 * Homebase ignores it until "Start review" moves it to `open`. The CLI and
 * agents create reviews as `open` directly.
 */
export const reviewStatusSchema = z.enum(['draft', 'open', 'orphaned', 'archived']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  /** Null until a detached `(repo, sha)` review adopts a branch. */
  branch: z.string().nullable(),
  pinnedSha: z.string().nullable(),
  baseRef: z.string(),
  prNumber: z.number().int().positive().nullable(),
  /** Null means no explicit choice yet, so the default applies (working when attached, else head). */
  currentRevision: revisionSchema.nullable(),
  lastSeenPrSha: z.string().nullable(),
  status: reviewStatusSchema,
  createdAt: z.number().int(),
});
export type Review = z.infer<typeof reviewSchema>;

/** CI roll-up for a PR head, derived server-side from `gh`'s `statusCheckRollup`. */
export const ciStatusSchema = z.enum(['passing', 'failing', 'pending']);
export type CiStatus = z.infer<typeof ciStatusSchema>;

/**
 * Homebase row roll-up: what a dashboard shows for a hundred reviews
 * without waking a hundred engines. DB aggregates plus one cached
 * `git diff base...head` per review and the PR row from the `gh` cache.
 * Ships alongside `Review` in `GET /api/reviews` rather than inside it,
 * since it's derived state, not the row's identity.
 */
export const reviewSummarySchema = z.object({
  reviewId: z.string(),
  openThreads: z.number().int().nonnegative(),
  resolvedThreads: z.number().int().nonnegative(),
  /**
   * Files whose *current* blob is marked viewed. When `filesTotal` is null
   * (head unresolvable) this falls back to distinct viewed paths.
   */
  viewedFiles: z.number().int().nonnegative(),
  /** Null when no reading order has been generated yet. */
  readingOrderVersion: z.number().int().nullable(),
  agentRunning: z.boolean(),
  /** Unix seconds of the newest thread, comment, viewed check, or reading order; null when untouched. */
  lastActivityAt: z.number().int().nullable(),

  /** PR title when a PR is known, else the tip commit's subject. */
  title: z.string().nullable(),
  /** PR author login when a PR is known, else the tip commit's author name. */
  authorName: z.string().nullable(),
  /** From `git diff -M base...head` for the review's `head`; null when head can't be resolved. */
  filesTotal: z.number().int().nonnegative().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  headSha: z.string().nullable(),
  /** Committer date of `head`, unix seconds. */
  headCommittedAt: z.number().int().nullable(),
  /** From the PR when one is known. */
  ci: ciStatusSchema.nullable(),
  draft: z.boolean(),
  /** Agent comments created after the review was last opened (never opened → all of them). */
  unreadAgentReplies: z.number().int().nonnegative(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/** `GET /api/me`: who the local user is, from `git config user.name` and `gh api user`. */
export const meSchema = z.object({
  name: z.string().nullable(),
  login: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

// --- branch and PR discovery ("open any branch or PR") ---

export const branchSchema = z.object({
  /** Short name, e.g. "feat/x" — no `refs/heads/` or `origin/` prefix. */
  name: z.string(),
  hasLocalRef: z.boolean(),
  hasRemoteRef: z.boolean(),
  tipSha: z.string(),
  /** Committer date, unix seconds, of whichever ref (local/remote) is newer. */
  committerDate: z.number().int(),
  subject: z.string().nullable(),
  authorName: z.string().nullable(),
  /** An existing review at `(repo, name)`, so the UI can land on it instead of creating a second one. */
  reviewId: z.string().nullable(),
  /** That review's status; null when `reviewId` is null. */
  reviewStatus: reviewStatusSchema.nullable(),
  /** Commits ahead of / behind the repo's default branch; null when git can't say (older git, no default ref). */
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
});
export type Branch = z.infer<typeof branchSchema>;

export const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  authorLogin: z.string().nullable(),
  /** ISO 8601, as `gh` reports it. */
  updatedAt: z.string(),
  /** The same instant as unix seconds, for sorting and relative times. */
  updatedAtUnix: z.number().int(),
  isDraft: z.boolean(),
  /** Null when `gh` didn't report them. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  changedFiles: z.number().int().nonnegative().nullable(),
  /** Roll-up of `statusCheckRollup`; null when the PR has no checks. */
  ci: ciStatusSchema.nullable(),
  /** True when the local `gh` login is a requested reviewer (or, login unknown, when anyone is). */
  reviewRequested: z.boolean(),
  /** An existing review at `(repo, headRefName)`; filled by the server from the DB. */
  reviewId: z.string().nullable(),
  /** That review's status; null when `reviewId` is null. */
  reviewStatus: reviewStatusSchema.nullable(),
});
export type Pull = z.infer<typeof pullSchema>;

// --- reading order ---

export const stepFileSchema = z.object({
  path: z.string(),
  noteMd: z.string().nullable(),
});
export type StepFile = z.infer<typeof stepFileSchema>;

export const stepSchema = z.object({
  id: z.string(),
  idx: z.number().int().nonnegative(),
  title: z.string(),
  explanationMd: z.string(),
  files: z.array(stepFileSchema),
});
export type Step = z.infer<typeof stepSchema>;

export const readingOrderSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  version: z.number().int().positive(),
  agentRunId: z.string().nullable(),
  createdAt: z.number().int(),
  steps: z.array(stepSchema),
  /**
   * Files present in the review but belonging to no step — they appeared after
   * the order was generated. Surfaced as a bucket with an offer to regenerate,
   * never silently folded in.
   */
  unassignedPaths: z.array(z.string()),
});
export type ReadingOrder = z.infer<typeof readingOrderSchema>;

/** The shape an agent writes via `review reading-order set --file plan.json`. */
export const readingOrderPlanSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        explanation_md: z.string().default(''),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              note_md: z.string().nullable().default(null),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type ReadingOrderPlan = z.infer<typeof readingOrderPlanSchema>;

// --- threads ---

export const threadSideSchema = z.enum(['old', 'new']);
export type ThreadSide = z.infer<typeof threadSideSchema>;

/**
 * Six fixed kinds, set by the user (UI), the embedded agent (tool), or an
 * external agent (CLI). Display glyphs and titles live in the web
 * (`lib/reactions.ts`) — the contract only names the kinds.
 */
export const reactionKindSchema = z.enum([
  'thumbs_up',
  'thumbs_down',
  'eyes',
  'check',
  'question',
  'tada',
]);
export type ReactionKind = z.infer<typeof reactionKindSchema>;

/** One kind on one comment, with everyone who set it (`user` first). */
export const reactionSchema = z.object({
  kind: reactionKindSchema,
  actors: z.array(z.enum(['user', 'agent'])),
});
export type Reaction = z.infer<typeof reactionSchema>;

export const commentSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  author: z.enum(['user', 'agent']),
  bodyMd: z.string(),
  agentRunId: z.string().nullable(),
  createdAt: z.number().int(),
  /** Empty when the comment has no reactions. */
  reactions: z.array(reactionSchema),
});
export type Comment = z.infer<typeof commentSchema>;

export const threadSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  path: z.string(),
  side: threadSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  anchorBlobSha: z.string(),
  anchorContextHash: z.string(),
  anchorContext: z.string(),
  status: z.enum(['open', 'resolved']),
  outdated: z.boolean(),
  changedSinceComment: z.boolean(),
  createdAt: z.number().int(),
  comments: z.array(commentSchema),
});
export type Thread = z.infer<typeof threadSchema>;

// --- agent runs ---

export const runKindSchema = z.enum(['reading_order', 'thread_reply']);
export type RunKind = z.infer<typeof runKindSchema>;

export const runStatusSchema = z.enum(['pending', 'running', 'done', 'error', 'cancelled']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const agentRunSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  threadId: z.string().nullable(),
  kind: runKindSchema,
  status: runStatusSchema,
  sessionId: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;
