/**
 * Read-time, non-persisted thread projection (SPEC §5 "Threads across
 * snapshots", extended for multi-revision caching).
 *
 * Thread rows are re-anchored and written back only against the review's
 * persisted revision (`reviewEngine.ts#tickOnce`) — writing from two
 * revisions in the same tick would race the one shared row. A tab watching a
 * *different* revision instead gets its line positions recomputed here, on
 * every fetch, without touching the database: same `relocate()` search the
 * persisted path uses, just never written back. There is nothing to
 * invalidate by construction — it's recomputed from the current blob every
 * time — so this deliberately does not cache its own result.
 */
import type { CatFile } from '../git/index.ts';
import { getFileContents } from '../git/index.ts';
import { relocate } from './anchor.ts';
import type { FileEntry, Revision, Thread } from '@review/core';

export type ProjectionContext = {
  readonly cwd: string;
  readonly revision: Revision;
  readonly catFile: CatFile;
};

/**
 * Project `thread` onto `revision`. Returns a copy with `startLine`/`endLine`
 * updated on a match; `outdated: true` (never persisted) when the file is
 * gone from this revision or the captured context no longer matches. Every
 * other field — including `anchorBlobSha`, which still reflects the
 * persisted revision's anchor — is passed through unchanged.
 */
export async function projectThread(
  thread: Thread,
  entry: FileEntry | undefined,
  ctx: ProjectionContext,
): Promise<Thread> {
  if (entry === undefined) {
    return { ...thread, outdated: true };
  }

  const sideBlob = thread.side === 'old' ? entry.oldBlob : entry.newBlob;
  // Exact match, free — but don't pass through a stale persisted `outdated`;
  // the blob matching the anchor means the original lines are valid again.
  if (sideBlob === thread.anchorBlobSha) return { ...thread, outdated: false };

  let contents;
  try {
    contents = await getFileContents({
      cwd: ctx.cwd,
      revision: ctx.revision,
      path: entry.path,
      oldBlob: entry.oldBlob,
      newBlob: entry.newBlob,
      catFile: ctx.catFile,
    });
  } catch {
    return { ...thread, outdated: true };
  }

  const text = thread.side === 'old' ? contents.oldContents : contents.newContents;
  if (text === null) return { ...thread, outdated: true };

  const located = relocate(text.split('\n'), thread);
  if (located === null) return { ...thread, outdated: true };
  return { ...thread, startLine: located.startLine, endLine: located.endLine, outdated: false };
}

/** Project every thread in `threads` onto `revision`, in parallel. */
export function projectThreads(
  threads: readonly Thread[],
  fileList: readonly FileEntry[],
  ctx: ProjectionContext,
): Promise<Thread[]> {
  const byPath = new Map(fileList.map((f) => [f.path, f]));
  return Promise.all(threads.map((t) => projectThread(t, byPath.get(t.path), ctx)));
}
