import { z } from 'zod';

/**
 * A review does not have "a" state; it has a revision picker (§4).
 *
 * `working` exists only while the branch is attached to a live directory.
 */
export const revisionSchema = z.enum(['working', 'head', 'pr']);
export type Revision = z.infer<typeof revisionSchema>;

export const fileStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed', 'copied']);
export type FileStatus = z.infer<typeof fileStatusSchema>;

/** git's all-zeros object id, used for the absent side of an add or delete. */
export const NULL_BLOB = '0000000000000000000000000000000000000000';

/**
 * One entry of the file list. The tuple `(path, oldBlob, newBlob)` is the whole
 * identity either side needs — there is no digest and no snapshot hash.
 */
export const fileEntrySchema = z.object({
  path: z.string(),
  /** Present on rename/copy entries so threads and viewed checks can be rewritten (§6). */
  oldPath: z.string().nullable(),
  status: fileStatusSchema,
  oldBlob: z.string(),
  newBlob: z.string(),
  binary: z.boolean(),
  /** From .gitattributes: collapsed by default and sorted to the bottom of the tree. */
  generated: z.boolean(),
  /** Null when unknown (binary, or not yet counted). */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/**
 * The state. Sorted by path; never re-sorted on update, so an added file lands
 * in place and nothing else shifts (§5).
 */
export const fileListSchema = z.object({
  reviewId: z.string(),
  revision: revisionSchema,
  baseSha: z.string(),
  headSha: z.string(),
  files: z.array(fileEntrySchema),
});
export type FileList = z.infer<typeof fileListSchema>;

/**
 * Git operations that detach HEAD momentarily. While one is in progress the
 * engine holds the last good snapshot rather than flapping the picker (§5).
 */
export const gitOperationSchema = z.enum([
  'rebase',
  'merge',
  'cherry-pick',
  'bisect',
  'revert',
  'am',
]);
export type GitOperation = z.infer<typeof gitOperationSchema>;

/** `git rev-list --left-right --count <head>...<pr>` (§4). */
export const divergenceSchema = z.object({
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
});
export type Divergence = z.infer<typeof divergenceSchema>;

export const rootBindingSchema = z.object({
  /** Null when nothing on disk holds the branch: `working` leaves the picker. */
  attachedPath: z.string().nullable(),
  /** Why `working` is unavailable, shown in the banner rather than left silent. */
  detachedReason: z
    .enum(['not-checked-out', 'directory-missing', 'branch-deleted', 'repo-unavailable'])
    .nullable(),
});
export type RootBinding = z.infer<typeof rootBindingSchema>;

export const reviewStateSchema = z.object({
  reviewId: z.string(),
  /** Only the revisions that actually exist right now. */
  availableRevisions: z.array(revisionSchema),
  currentRevision: revisionSchema,
  root: rootBindingSchema,
  divergence: divergenceSchema.nullable(),
  /** True when base(main, pr) and base(main, head) no longer coincide (§4). */
  basesMismatched: z.boolean(),
  operationInProgress: gitOperationSchema.nullable(),
  prNumber: z.number().int().positive().nullable(),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;
