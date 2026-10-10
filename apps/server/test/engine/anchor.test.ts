/**
 * Unit coverage for `apps/server/src/engine/anchor.ts`: the pure
 * functions that decide where a thread's anchor lands after the code under
 * it moves. `findSubsequence` and `relocate` are the load-bearing ones — a
 * bug here is silent data loss with a plausible face (threads are
 * never deleted, only relocated or marked `outdated`).
 */
import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_RADIUS,
  captureContext,
  findAllSubsequences,
  findSubsequence,
  hashContext,
  relocate,
} from '../../src/engine/anchor.ts';

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

describe('findAllSubsequences', () => {
  test('returns every match, in ascending order, not just the first', () => {
    expect(findAllSubsequences(['p', 'q', 'x', 'y', 'p', 'q'], ['p', 'q'])).toEqual([0, 4]);
  });

  test('three matches, including overlapping ones', () => {
    expect(findAllSubsequences(['a', 'a', 'a', 'a'], ['a', 'a'])).toEqual([0, 1, 2]);
  });

  test('no matches returns an empty array, not null', () => {
    expect(findAllSubsequences(['a', 'b', 'c'], ['x'])).toEqual([]);
  });

  test('empty needle returns an empty array', () => {
    expect(findAllSubsequences(['a', 'b'], [])).toEqual([]);
  });

  test('single unambiguous match returns a one-element array', () => {
    expect(findAllSubsequences(['a', 'b', 'c'], ['b'])).toEqual([1]);
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

  test('CRLF vs LF hashes identically — normalized before hashing (Issue 2 fix)', () => {
    // Traced the read path feeding `captureContext`/`hashContext`
    // (reviewEngine.ts#reanchorThreads, routes.ts's thread-creation
    // handler) back through git/diff.ts#getFileContents: committed blobs
    // come back verbatim from `cat-file --batch` and a `working` revision's
    // new side is a plain `fs.readFile` + `TextDecoder` — no line-ending
    // normalization anywhere upstream. So a pure CRLF/LF change (a file
    // resaved by a different tool) must not change the hash or the
    // anchoring outcome; `hashContext` now normalizes a trailing '\r' away
    // per line before hashing.
    expect(hashContext('line\r')).toBe(hashContext('line'));
  });

  test('trailing whitespace on a line hashes identically to the trimmed line', () => {
    expect(hashContext('line   ')).toBe(hashContext('line'));
  });

  test('normalization is per-line, not a blanket trim: interior/leading whitespace is untouched', () => {
    expect(hashContext('  line')).not.toBe(hashContext('line'));
    expect(hashContext('a  b')).not.toBe(hashContext('a b'));
  });

  test('captureContext stores already-normalized text, so trailing whitespace/CRLF never reaches anchorContext', () => {
    const crlfLines = ['l1\r', 'l2  \r', 'TARGET\r', 'l4\r', 'l5\r'];
    const { context, hash } = captureContext(crlfLines, 3, 3);
    expect(context).toBe(['l1', 'l2', 'TARGET', 'l4', 'l5'].join('\n'));
    expect(hash).toBe(hashContext(['l1', 'l2', 'TARGET', 'l4', 'l5'].join('\n')));
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

  test('two equidistant identical copies of the context: genuinely ambiguous, goes outdated rather than guessing', () => {
    // Two copies of the single-line context "BLOCK", placed so
    // their resulting candidate lines are *exactly* equidistant (4 lines
    // either side) from the thread's last known line (10): neither is
    // closer than the other, so there is no basis to prefer one over the
    // other. Silently picking the first (old behaviour) risks attaching the
    // comment to the *wrong* one of two identical blocks with false
    // confidence. Marking it `outdated` (relocate returns null) is
    // recoverable; a wrong silent relocation is not.
    const haystack = ['x0', 'x1', 'BLOCK', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'BLOCK', 'x11'];
    const thread = { anchorContext: 'BLOCK', startLine: 10, endLine: 10 };
    // Candidate A: index 2 -> startLine 6 (distance |6-10| = 4).
    // Candidate B: index 10 -> startLine 14 (distance |14-10| = 4). Tied.
    const result = relocate(haystack, thread);
    expect(result).toBeNull();
  });

  test('three or more identical copies: the one unambiguously nearest the original line wins', () => {
    const original = ['pad1', 'pad2', 'a', 'b', 'BLOCK', 'c', 'd'];
    const thread = ctx(original, 5, 5); // BLOCK at line 5; captures lines 2..7 (radius 3 clipped after by EOF): pad2,a,b,BLOCK,c,d

    // Three copies of the captured 6-line context, at three different
    // distances from the original startLine (5): one very close, one
    // moderately far, one very far. Only the closest may win; the other
    // two exist to confirm a 3rd/4th candidate doesn't confuse the
    // proximity scan.
    const nearFiller = Array.from({ length: 5 }, (_, i) => `near-filler${i}`);
    const midFiller = Array.from({ length: 50 }, (_, i) => `mid-filler${i}`);
    const farFiller = Array.from({ length: 500 }, (_, i) => `far-filler${i}`);
    const copy = ['pad2', 'a', 'b', 'BLOCK', 'c', 'd']; // matches thread.anchorContext exactly
    const threeCopies = [...nearFiller, ...copy, ...midFiller, ...copy, ...farFiller, ...copy];

    const result = relocate(threeCopies, thread);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('nearest');
    // Nearest copy: 'pad2' at 0-indexed 5, 'BLOCK' at 0-indexed 8 -> 1-indexed startLine 9.
    expect(result?.startLine).toBe(9);
  });

  test('ambiguous but tie-breakable: one candidate near the original line, one far away — the near one wins', () => {
    // Same captured context appears twice, at very different distances from
    // where the thread used to be. Proximity to the last known line breaks
    // the tie deterministically and plausibly (code drifts a little, it
    // doesn't teleport across the file).
    const original = ['pad1', 'pad2', 'pad3', 'pad4', 'pad5', 'a', 'b', 'BLOCK', 'c', 'd'];
    const thread = ctx(original, 8, 8); // BLOCK at line 8; captures lines 5..10 (whole file)

    const filler = Array.from({ length: 300 }, (_, i) => `filler${i}`); // 300 lines of unrelated padding
    // One copy of the captured context sits right where it used to be
    // (near line 8); an identical copy sits far away, deep in the filler.
    const nearAndFar = [
      'pad5',
      'a',
      'b',
      'BLOCK',
      'c',
      'd',
      'pad1',
      'pad2', // near copy: starts at line 1, 'BLOCK' at line 4
      ...filler, // lines 9..308
      'pad5',
      'a',
      'b',
      'BLOCK',
      'c',
      'd', // far copy: starts at line 309, 'BLOCK' at line 312
    ];
    const result = relocate(nearAndFar, thread);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe('nearest');
    expect(result?.startLine).toBe(4); // the near copy (distance 4 from original line 8), not the far one (distance ~304)
  });

  test('a single unambiguous match reports confidence "unique"', () => {
    const original = ['a', 'b', 'TARGET', 'c', 'd'];
    const thread = ctx(original, 3, 3);
    const shifted = ['x', 'y', 'a', 'b', 'TARGET', 'c', 'd'];
    const result = relocate(shifted, thread);
    expect(result?.confidence).toBe('unique');
  });

  test('CRLF-only change in the file being searched does not orphan the thread', () => {
    // The captured context (from a clean LF file) must still be found in a
    // haystack whose lines carry trailing '\r' (as if the file was resaved
    // with CRLF endings) or trailing whitespace — a purely cosmetic change,
    // not a content change.
    const original = ['a', 'b', 'TARGET', 'c', 'd'];
    const thread = ctx(original, 3, 3);
    const crlfVersion = ['a\r', 'b\r', 'TARGET\r', 'c\r', 'd\r'];
    const result = relocate(crlfVersion, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(3);
  });

  test('trailing-whitespace-only change in the file being searched does not orphan the thread', () => {
    const original = ['a', 'b', 'TARGET', 'c', 'd'];
    const thread = ctx(original, 3, 3);
    const trimmedAway = ['a  ', 'b', 'TARGET   ', 'c', 'd '];
    const result = relocate(trimmedAway, thread);
    expect(result).not.toBeNull();
    expect(result?.startLine).toBe(3);
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
