/**
 * Thread anchoring and re-anchoring.
 *
 * An anchor is `(path, side, line range, blob SHA, hash of +-3 context
 * lines)`. `anchorContext` is the literal captured text; `anchorContextHash`
 * is stored alongside it as a cheap fingerprint. Neither is ever recomputed
 * once a thread exists — content that hasn't moved is byte-identical, so the
 * original capture stays valid across every future relocation. Only
 * `startLine`/`endLine`/`anchorBlobSha` change when a relocation succeeds.
 *
 * Known limitation: the number of "before"
 * context lines captured is re-derived from the thread's *current* stored
 * `startLine` each time, rather than persisted from the original capture.
 * This is exact except when a thread was created within `CONTEXT_RADIUS`
 * lines of the top of the file and later relocates to a position where the
 * boundary clipping would have differed — a rare edge the schema has no
 * column to store precisely (no `before_count` field).
 *
 * Whitespace/line-ending normalization (2026-09-11): traced the read path feeding `captureContext`/`relocate`
 * back through `reviewEngine.ts#reanchorThreads` and `routes.ts`'s
 * thread-creation handler into `git/diff.ts#getFileContents`. Committed
 * sides come back verbatim from `cat-file --batch` — whatever bytes git
 * stored, no `core.autocrlf`-equivalent pass applied — and a `working`
 * revision's new side is `fs.readFile` + `TextDecoder`, also verbatim. No
 * normalization happens anywhere upstream of this file, so it belongs here.
 * See `normalizeLine` below for what's normalized and why.
 */

export const CONTEXT_RADIUS = 3;

/**
 * Strip a trailing CR (so CRLF and LF read the same) and trailing
 * horizontal whitespace from one line. Applied everywhere a line is turned
 * into anchor text or compared against one, so that a purely cosmetic
 * change — a file resaved with different line endings, an editor trimming
 * trailing spaces — never orphans a thread or changes its hash. The
 * tradeoff: a comment anchored to a line whose *only* change was trailing
 * whitespace or its line-ending style will keep matching as if nothing
 * happened, including not tripping `changedSinceComment`. That's the
 * intended behaviour — a reviewer would call that line "unchanged", not a
 * near-miss — but it does mean anchoring is deliberately blind to that one
 * category of edit.
 */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').replace(/[ \t]+$/, '');
}

/** Apply `normalizeLine` to every line of a `\n`-joined block of text. */
function normalizeContext(text: string): string {
  return text.split('\n').map(normalizeLine).join('\n');
}

/**
 * sha256 hex of `text` (after {@link normalizeLine} normalization per line),
 * used as `anchorContextHash`. Normalizing here — in addition to
 * `captureContext` already storing normalized text — means the hash is
 * meaningful even if ever called on text that wasn't captured through
 * `captureContext` (defensive, and cheap since normalizing already-clean
 * text is a no-op).
 */
export function hashContext(text: string): string {
  return new Bun.CryptoHasher('sha256').update(normalizeContext(text)).digest('hex');
}

/**
 * Capture the +-`CONTEXT_RADIUS` lines around `[startLine, endLine]`
 * (1-indexed, inclusive) from `lines`, for a freshly created thread's anchor.
 * Captured lines are normalized (see `normalizeLine`) before being stored,
 * so the anchor is immune to whitespace/line-ending-only churn from the
 * moment it's created.
 */
export function captureContext(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): { context: string; hash: string } {
  const from = Math.max(1, startLine - CONTEXT_RADIUS);
  const to = Math.min(lines.length, endLine + CONTEXT_RADIUS);
  const context = lines
    .slice(from - 1, to)
    .map(normalizeLine)
    .join('\n');
  return { context, hash: hashContext(context) };
}

/** First index in `haystack` where `needle` occurs as a contiguous run, or null. */
export function findSubsequence(haystack: readonly string[], needle: readonly string[]): number | null {
  return findAllSubsequences(haystack, needle)[0] ?? null;
}

/**
 * Every index in `haystack` where `needle` occurs as a contiguous run, in
 * ascending order (matches may overlap each other). Empty needle or a
 * needle longer than the haystack yields no matches, matching
 * `findSubsequence`'s null-on-empty-needle contract.
 */
export function findAllSubsequences(haystack: readonly string[], needle: readonly string[]): number[] {
  const indices: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return indices;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    indices.push(i);
  }
  return indices;
}

export type RelocateInput = {
  readonly anchorContext: string;
  readonly startLine: number;
  readonly endLine: number;
};

export type RelocateResult = {
  readonly startLine: number;
  readonly endLine: number;
  /**
   * `'unique'` — the captured context occurs exactly once in the new file;
   * this is as confident as re-anchoring gets.
   * `'nearest'` — the context occurs more than once, but exactly one
   * candidate is strictly closer to the thread's last known line than
   * every other candidate, and that proximity tie-break was used to pick
   * it. Still a real relocation (not `outdated`), but a caller that wants
   * to badge "we guessed" rather than "we know" can use this to
   * distinguish the two. There is currently no caller that reads this
   * field differently from `'unique'`; it exists so relocation confidence
   * is representable rather than silently collapsed to a boolean.
   */
  readonly confidence: 'unique' | 'nearest';
};

/**
 * Search `newLines` for the thread's captured context. Returns the new line
 * range on a hit, or null on a miss (caller marks the thread `outdated`).
 *
 * Ambiguity policy:
 * duplicated context is realistic (boilerplate, repeated test cases,
 * `} catch (e) {`, copy-pasted functions), and the old behaviour — silently
 * take the earliest match — was a coin flip dressed up as certainty: a
 * thread could attach to the *wrong* one of two identical blocks with no
 * signal to anyone that the match was ambiguous. That is strictly worse
 * than `outdated`, because `outdated` is visible and recoverable (the user
 * re-locates their own comment) while a wrong-but-confident relocation
 * silently moves a comment onto code nobody asked about it.
 *
 * So: when the context matches more than once,
 *  1. break the tie by proximity — the candidate whose resulting start line
 *     is strictly closer to the thread's previous `startLine` than every
 *     other candidate wins. Code under active review usually drifts by a
 *     few lines (a comment added above, a reflow), not across the file, so
 *     "closest to where it was" is a real, not arbitrary, signal.
 *  2. if there is no single strictly-closest candidate (two or more tie for
 *     closest — including the common case of one match just as far above as
 *     another is below), that tie is genuine ambiguity with no basis to
 *     break it further, and the thread goes `outdated` rather than guess.
 *
 * A "prefer a longer/more specific match" tie-breaker was also considered
 * (per the task brief) but doesn't apply *within* this function: every
 * candidate here matched the exact same needle (the thread's one fixed
 * captured context), so by construction no candidate is longer or more
 * specific than another. That tie-breaker would only matter for an
 * architecture that retries relocation with progressively shorter context
 * windows — this one doesn't (see `CONTEXT_RADIUS`), so it's noted here as
 * a considered-and-rejected option rather than implemented dead code.
 */
export function relocate(newLines: readonly string[], thread: RelocateInput): RelocateResult | null {
  const contextLines = thread.anchorContext === '' ? [] : thread.anchorContext.split('\n').map(normalizeLine);
  const haystack = newLines.map(normalizeLine);
  const candidates = findAllSubsequences(haystack, contextLines);
  if (candidates.length === 0) return null;

  const beforeCount = Math.min(CONTEXT_RADIUS, thread.startLine - 1);
  const rangeFor = (idx: number): { startLine: number; endLine: number } => {
    const newStartLine = idx + beforeCount + 1;
    return { startLine: newStartLine, endLine: newStartLine + (thread.endLine - thread.startLine) };
  };

  if (candidates.length === 1) {
    const first = candidates[0];
    if (first === undefined) return null; // unreachable (length === 1), satisfies noUncheckedIndexedAccess
    return { ...rangeFor(first), confidence: 'unique' };
  }

  let bestIdx: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tiedAtBest = false;
  for (const idx of candidates) {
    const distance = Math.abs(rangeFor(idx).startLine - thread.startLine);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIdx = idx;
      tiedAtBest = false;
    } else if (distance === bestDistance) {
      tiedAtBest = true;
    }
  }
  if (bestIdx === null || tiedAtBest) return null; // genuinely ambiguous: mark outdated, don't guess
  return { ...rangeFor(bestIdx), confidence: 'nearest' };
}
