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

export const reviewStatusSchema = z.enum(['open', 'orphaned', 'archived']);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  /** Null until a detached `(repo, sha)` review adopts a branch (§4). */
  branch: z.string().nullable(),
  pinnedSha: z.string().nullable(),
  baseRef: z.string(),
  prNumber: z.number().int().positive().nullable(),
  attachedPath: z.string().nullable(),
  currentRevision: revisionSchema,
  lastSeenPrSha: z.string().nullable(),
  status: reviewStatusSchema,
  createdAt: z.number().int(),
});
export type Review = z.infer<typeof reviewSchema>;

// --- reading order (§7) ---

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
   * never silently folded in (§5).
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

// --- threads (§8) ---

export const threadSideSchema = z.enum(['old', 'new']);
export type ThreadSide = z.infer<typeof threadSideSchema>;

export const commentSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  author: z.enum(['user', 'agent']),
  bodyMd: z.string(),
  agentRunId: z.string().nullable(),
  createdAt: z.number().int(),
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

// --- agent runs (§9) ---

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
