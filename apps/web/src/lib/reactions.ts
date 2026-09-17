/**
 * Display glyphs and titles for the six fixed reaction kinds (SPEC feature:
 * agent reply mechanism and reactions, R1). The contract only names the
 * kinds (`packages/core/src/domain/review.ts`) — the web owns how they look.
 */
import type { Reaction, ReactionKind } from '@review/core';

export const REACTIONS: { kind: ReactionKind; glyph: string; title: string }[] = [
  { kind: 'thumbs_up', glyph: '👍', title: 'Agree' },
  { kind: 'thumbs_down', glyph: '👎', title: 'Disagree' },
  { kind: 'eyes', glyph: '👀', title: 'Looking' },
  { kind: 'check', glyph: '✅', title: 'Done' },
  { kind: 'question', glyph: '❓', title: 'Unclear' },
  { kind: 'tada', glyph: '🎉', title: 'Nice' },
];

const GLYPH_BY_KIND = new Map(REACTIONS.map((r) => [r.kind, r.glyph]));

export function glyphOf(kind: ReactionKind): string {
  return GLYPH_BY_KIND.get(kind) ?? '?';
}

/**
 * Optimistic local toggle of one actor's reaction on a comment's reaction
 * list, used by `ReviewContext.setReaction` before the request round-trips.
 * Doesn't try to reproduce the server's actor ordering exactly — it only has
 * to look right until the `thread.updated` event (or the response itself)
 * replaces it with the real thing.
 */
export function toggleReactionLocally(
  reactions: readonly Reaction[],
  kind: ReactionKind,
  actor: 'user' | 'agent',
  on: boolean,
): Reaction[] {
  const idx = reactions.findIndex((r) => r.kind === kind);
  if (on) {
    if (idx === -1) return [...reactions, { kind, actors: [actor] }];
    const existing = reactions[idx];
    if (existing === undefined || existing.actors.includes(actor)) return reactions.slice();
    const actors = actor === 'user' ? [actor, ...existing.actors] : [...existing.actors, actor];
    return reactions.map((r, i) => (i === idx ? { kind, actors } : r));
  }
  if (idx === -1) return reactions.slice();
  const existing = reactions[idx];
  if (existing === undefined) return reactions.slice();
  const actors = existing.actors.filter((a) => a !== actor);
  if (actors.length === 0) return reactions.filter((_, i) => i !== idx);
  return reactions.map((r, i) => (i === idx ? { kind, actors } : r));
}
