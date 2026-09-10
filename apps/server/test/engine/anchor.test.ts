/**
 * Unit coverage for `apps/server/src/engine/anchor.ts` (SPEC §8): the pure
 * functions that decide where a thread's anchor lands after the code under
 * it moves. `findSubsequence` and `relocate` are the load-bearing ones — a
 * bug here is silent data loss with a plausible face (SPEC §8: threads are
 * never deleted, only relocated or marked `outdated`).
 */
import { describe, expect, test } from 'bun:test';
import { CONTEXT_RADIUS, captureContext, findSubsequence, hashContext, relocate } from '../../src/engine/anchor.ts';

describe('findSubsequence', () => {
  test('found at the start', () => {
    expect(findSubsequence(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(0);
  });

  test('found in the middle', () => {
    expect(findSubsequence(['a', 'b', 'c', 'd'], ['b', 'c'])).toBe(1);
  });

  test('found at the end', () => {
    expect(findSubsequence(['a', 'b', 'c', 'd'], ['c', 'd'])).toBe(2);
  });

  test('not found', () => {
    expect(findSubsequence(['a', 'b', 'c'], ['x', 'y'])).toBeNull();
  });

  test('needle longer than haystack', () => {
    expect(findSubsequence(['a', 'b'], ['a', 'b', 'c'])).toBeNull();
  });

  test('empty needle returns null, not a match at index 0 — deliberately asserted', () => {
    // This matters for `relocate`: if an empty `anchorContext` ever reached
    // `findSubsequence` and it returned 0 instead of null, a thread with a
    // blank captured context would silently "relocate" to the top of the
    // file rather than going outdated. The current code guards this
    // explicitly (`needle.length === 0` short-circuits to null), which is
    // the right call — asserting it here pins that guard against regression.
    expect(findSubsequence(['a', 'b', 'c'], [])).toBeNull();
    expect(findSubsequence([], [])).toBeNull();
  });

  test('single-line needle', () => {
    expect(findSubsequence(['x', 'y', 'z'], ['y'])).toBe(1);
  });

  test('multiple matches: the first (earliest) index wins', () => {
    // Two identical two-line runs in the haystack — the function returns the
    // first occurrence. For `relocate`'s ambiguity case (see below) this is
    // the behaviour actually exercised; documented here at the primitive
    // level so the contract is explicit independent of `relocate`.
    expect(findSubsequence(['p', 'q', 'x', 'y', 'p', 'q'], ['p', 'q'])).toBe(0);
  });

  test('overlapping repeated content: needle that overlaps itself in the haystack', () => {
    // haystack "a a a", needle "a a" — a naive non-overlapping scan could
    // miss the second match; index-by-index scanning must not.
    expect(findSubsequence(['a', 'a', 'a'], ['a', 'a'])).toBe(0);
    // Haystack where the *first* possible start doesn't match but an
    // overlapping later one does.
    expect(findSubsequence(['x', 'a', 'a', 'a'], ['a', 'a'])).toBe(1);
  });
});

describe('captureContext / hashContext', () => {
  const lines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'];

  test('context at the very first line clips the "before" radius at the boundary', () => {
    const { context } = captureContext(lines, 1, 1);
    // radius 3, but there's nothing before line 1 — clipped to lines 1..4
    expect(context).toBe(['l1', 'l2', 'l3', 'l4'].join('\n'));
  });

  test('context at the very last line clips the "after" radius at the boundary', () => {
    const { context } = captureContext(lines, 10, 10);
    // clipped to lines 7..10
    expect(context).toBe(['l7', 'l8', 'l9', 'l10'].join('\n'));
  });

  test('a file shorter than CONTEXT_RADIUS captures the whole file both ways', () => {
    const short = ['only1', 'only2'];
    const { context } = captureContext(short, 1, 1);
    expect(context).toBe(short.join('\n'));
  });

  test('a single-line file', () => {
    const one = ['solo'];
    const { context } = captureContext(one, 1, 1);
    expect(context).toBe('solo');
  });

  test('an empty file (no lines) produces an empty context', () => {
    const { context, hash } = captureContext([], 1, 1);
    expect(context).toBe('');
    expect(hash).toBe(hashContext(''));
  });

  test('a multi-line thread captures context around the whole range, not just one end', () => {
    const { context } = captureContext(lines, 4, 6);
    // radius 3 before line4 -> line1, radius 3 after line6 -> line9
    expect(context).toBe(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n'));
  });

  test('identical content hashes identically', () => {
    expect(hashContext('same text')).toBe(hashContext('same text'));
  });

  test('different content hashes differently', () => {
    expect(hashContext('text a')).not.toBe(hashContext('text b'));
  });

  test('CRLF vs LF is a different hash — captured context is byte-sensitive', () => {
    // Flagged, not silently blessed: `captureContext` joins raw line strings
    // with '\n', and if the source lines themselves carry a trailing '\r'
    // (a file read without CRLF normalization) that '\r' is baked into the
    // hash. This is defensible only if the read path normalizes line
    // endings upstream; if it doesn't, a mixed-line-ending file could fail
    // to re-anchor after a tool resaves it with different endings. Worth
    // confirming upstream normalization exists — see IMPROVEMENTS.md.
    expect(hashContext('line\r')).not.toBe(hashContext('line'));
  });

  test('trailing whitespace on a line is a different hash', () => {
    expect(hashContext('line   ')).not.toBe(hashContext('line'));
  });
});

describe('relocate', () => {
  function ctx(lines: readonly string[], startLine: number, endLine: number): { anchorContext: string; startLine: number; endLine: number } {
    const { context } = captureContext(lines, startLine, endLine);
    return { anchorContext: context, startLine, endLine };
  }

  test('lines inserted above the thread shift it down by exactly that amount', () => {
    const original = ['a', 'b', 'TARGET', 'c', 'd'];
    const thread = ctx(original, 3, 3); // captures b, TARGET, c, d (clipped before, radius 3 after)
    const withInsertions = ['x', 'y', 'a', 'b', 'TARGET', 'c', 'd'];
    const result = relocate(withInsertions, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(5); // 3 + 2 inserted lines
    expect(result?.endLine).toBe(5);
  });

  test('lines deleted above the thread (but above its captured context) shift it up', () => {
    // z1,z2 sit above the ±3 context window entirely, so deleting them
    // leaves the captured context byte-for-byte intact and only shifts its
    // position.
    const original = ['z1', 'z2', 'z3', 'z4', 'a', 'b', 'c', 'd', 'TARGET', 'e', 'f'];
    const thread = ctx(original, 9, 9); // TARGET is line 9
    const withDeletions = ['z3', 'z4', 'a', 'b', 'c', 'd', 'TARGET', 'e', 'f']; // removed z1, z2
    const result = relocate(withDeletions, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(7); // 9 - 2 deleted lines
  });

  test('the anchored block unchanged but moved far away is still found', () => {
    const original = ['head1', 'head2', 'head3', 'TARGET', 'tail1', 'tail2', 'tail3'];
    const thread = ctx(original, 4, 4);
    const filler = Array.from({ length: 500 }, (_, i) => `filler${i}`);
    const moved = [...filler, 'head1', 'head2', 'head3', 'TARGET', 'tail1', 'tail2', 'tail3'];
    const result = relocate(moved, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(504);
  });

  test('the anchored block itself edited returns null (outdated) rather than a wrong-but-confident position', () => {
    const original = ['a', 'b', 'TARGET', 'c', 'd'];
    const thread = ctx(original, 3, 3);
    const edited = ['a', 'b', 'TARGET-CHANGED', 'c', 'd'];
    const result = relocate(edited, thread);
    expect(result).toBeNull();
  });

  test('two identical copies of the anchored block: the first copy wins (documented ambiguity, not obviously correct)', () => {
    // This is the genuinely ambiguous case flagged in the task brief. The
    // current behaviour (inherited from findSubsequence's earliest-match
    // semantics) is to silently pick the first occurrence, with no signal
    // to the caller that the match was ambiguous. That's a defensible
    // choice (some answer beats none, and it's deterministic) but it is
    // also a real way for a thread to attach to the *wrong* one of two
    // identical blocks with full confidence and no `outdated` flag. This
    // test pins current behaviour; see IMPROVEMENTS.md for the escalation.
    const original = ['pre', 'BLOCK', 'mid1', 'mid2', 'mid3', 'mid4', 'mid5', 'mid6', 'BLOCK', 'post'];
    const thread = ctx(original, 2, 2); // anchors the *first* BLOCK
    // Re-run relocate against the very same content: both copies are valid
    // candidate matches for the 1-line context "BLOCK" alone in isolation,
    // but captureContext included surrounding lines, so let's construct a
    // case where the *captured context itself* is duplicated verbatim
    // elsewhere in the new file.
    const dup = ['pre', 'BLOCK', 'mid1', 'mid2', 'unrelated', 'pre', 'BLOCK', 'mid1', 'mid2', 'tail'];
    // Build a thread whose 2-line context ("pre","BLOCK") appears twice in `dup`.
    const twoLineThread = { anchorContext: ['pre', 'BLOCK'].join('\n'), startLine: 2, endLine: 2 };
    const result = relocate(dup, twoLineThread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(2); // first occurrence, index 0 + beforeCount(1) + 1
    // (the `thread` var from ctx() above is unused in this duplicate-context
    // scenario; keep the realistic captureContext-built fixture for
    // reference/documentation of how a thread would normally be built)
    void thread;
  });

  test('a multi-line thread spanning a region that gets split apart returns null', () => {
    const original = ['a', 'TOP', 'MID', 'BOTTOM', 'b'];
    const thread = ctx(original, 2, 4); // TOP..BOTTOM as one block
    const split = ['a', 'TOP', 'inserted-in-the-middle', 'MID', 'BOTTOM', 'b'];
    const result = relocate(split, thread);
    expect(result).toBeNull();
  });

  test('the anchored content deleted entirely does not throw and returns null', () => {
    const original = ['a', 'b', 'TARGET', 'c', 'd'];
    const thread = ctx(original, 3, 3);
    const gone = ['a', 'b', 'c', 'd'];
    expect(() => relocate(gone, thread)).not.toThrow();
    expect(relocate(gone, thread)).toBeNull();
  });

  test('a thread anchored at line 1 relocates correctly after insertion above the file start', () => {
    const original = ['TARGET', 'b', 'c'];
    const thread = ctx(original, 1, 1); // context has no "before" lines (clipped)
    const shifted = ['new-first-line', 'TARGET', 'b', 'c'];
    const result = relocate(shifted, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(2);
  });

  test('a thread anchored at the last line relocates correctly', () => {
    const original = ['a', 'b', 'TARGET'];
    const thread = ctx(original, 3, 3);
    const shifted = ['a', 'b', 'TARGET', 'new-last-line'];
    const result = relocate(shifted, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(3);
  });

  test('content moved to a position before its original location', () => {
    const original = ['pad1', 'pad2', 'pad3', 'pad4', 'pad5', 'ctx1', 'ctx2', 'TARGET', 'ctx3', 'ctx4', 'pad6'];
    const thread = ctx(original, 8, 8); // TARGET originally at line 8
    // Move the whole captured-context block (pad5, ctx1, ctx2, TARGET, ctx3,
    // ctx4, pad6) to the front of the file, ahead of the other padding.
    const movedUp = ['pad5', 'ctx1', 'ctx2', 'TARGET', 'ctx3', 'ctx4', 'pad6', 'pad1', 'pad2', 'pad3', 'pad4'];
    const result = relocate(movedUp, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(4); // now earlier than before (8 -> 4), not clamped or confused
  });

  test('CONTEXT_RADIUS is 3 as documented', () => {
    expect(CONTEXT_RADIUS).toBe(3);
  });
});
