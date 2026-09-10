/**
 * Thread anchoring and re-anchoring (SPEC §8, §5 "Threads across snapshots").
 *
 * An anchor is `(path, side, line range, blob SHA, hash of +-3 context
 * lines)`. `anchorContext` is the literal captured text; `anchorContextHash`
 * is stored alongside it as a cheap fingerprint. Neither is ever recomputed
 * once a thread exists — content that hasn't moved is byte-identical, so the
 * original capture stays valid across every future relocation. Only
 * `startLine`/`endLine`/`anchorBlobSha` change when a relocation succeeds.
 *
 * Known limitation (documented in IMPROVEMENTS.md): the number of "before"
 * context lines captured is re-derived from the thread's *current* stored
 * `startLine` each time, rather than persisted from the original capture.
 * This is exact except when a thread was created within `CONTEXT_RADIUS`
 * lines of the top of the file and later relocates to a position where the
 * boundary clipping would have differed — a rare edge the schema has no
 * column to store precisely (no `before_count` field).
 */

export const CONTEXT_RADIUS = 3;

/** sha256 hex of `text`, used as `anchorContextHash`. */
export function hashContext(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/**
 * Capture the +-`CONTEXT_RADIUS` lines around `[startLine, endLine]`
 * (1-indexed, inclusive) from `lines`, for a freshly created thread's anchor.
 */
export function captureContext(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): { context: string; hash: string } {
  const from = Math.max(1, startLine - CONTEXT_RADIUS);
  const to = Math.min(lines.length, endLine + CONTEXT_RADIUS);
  const context = lines.slice(from - 1, to).join('\n');
  return { context, hash: hashContext(context) };
}

/** First index in `haystack` where `needle` occurs as a contiguous run, or null. */
export function findSubsequence(haystack: readonly string[], needle: readonly string[]): number | null {
  if (needle.length === 0 || needle.length > haystack.length) return null;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return null;
}

export type RelocateInput = {
  readonly anchorContext: string;
  readonly startLine: number;
  readonly endLine: number;
};

export type RelocateResult = {
  readonly startLine: number;
  readonly endLine: number;
};

/**
 * Search `newLines` for the thread's captured context. Returns the new line
 * range on a hit, or null on a miss (caller marks the thread `outdated`).
 */
export function relocate(newLines: readonly string[], thread: RelocateInput): RelocateResult | null {
  const contextLines = thread.anchorContext === '' ? [] : thread.anchorContext.split('\n');
  const idx = findSubsequence(newLines, contextLines);
  if (idx === null) return null;

  const beforeCount = Math.min(CONTEXT_RADIUS, thread.startLine - 1);
  const newStartLine = idx + beforeCount + 1;
  const newEndLine = newStartLine + (thread.endLine - thread.startLine);
  return { startLine: newStartLine, endLine: newEndLine };
}
