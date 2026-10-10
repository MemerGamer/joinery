/**
 * Every path comparison in the engine goes through this one function. Git
 * resolves symlinks and reports
 * canonical paths — on macOS a worktree at `/tmp/x` lists as `/private/tmp/x`
 * — so attach lookup, dedupe, refcounting, and "is this the root I'm
 * watching" all normalize through realpath first, or they silently fail to
 * match.
 */
import { realpath } from 'node:fs/promises';

/**
 * Resolve `p` to its canonical, symlink-free absolute path.
 *
 * Throws if the path does not exist — callers that need to canonicalize a
 * path that may have vanished (e.g. a stale worktree) should catch and
 * handle that themselves rather than treating this as a pure string
 * transform.
 */
export async function canonicalizePath(p: string): Promise<string> {
  return await realpath(p);
}
