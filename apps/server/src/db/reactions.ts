/**
 * `reaction` — one row per `(comment, actor, kind)`. Setting a reaction
 * on is insert-or-ignore, off is a delete; there is no update, since the row
 * carries no state beyond the triple existing.
 */
import { reaction } from '@joinery/core/db';
import { reactionKindSchema, type Reaction, type ReactionKind } from '@joinery/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.ts';
import { narrowUnion } from './narrow.ts';

const ACTORS = ['user', 'agent'] as const;
type Actor = (typeof ACTORS)[number];

export type SetReactionInput = {
  readonly commentId: string;
  readonly actor: Actor;
  readonly kind: ReactionKind;
  /** False removes the reaction. */
  readonly on: boolean;
};

export async function setReaction(db: Db, input: SetReactionInput): Promise<void> {
  if (input.on) {
    await db
      .insert(reaction)
      .values({ commentId: input.commentId, actor: input.actor, kind: input.kind })
      .onConflictDoNothing();
  } else {
    await db
      .delete(reaction)
      .where(
        and(
          eq(reaction.commentId, input.commentId),
          eq(reaction.actor, input.actor),
          eq(reaction.kind, input.kind),
        ),
      );
  }
}

/**
 * Batched for `getThreadWithComments`/`listThreadsByReview`: one query for
 * every comment in a thread (or a whole review), never one per comment.
 * Actors within a kind are sorted `user` first; kinds come back in
 * `reactionKindSchema`'s fixed order.
 */
export async function listReactionsForComments(
  db: Db,
  commentIds: readonly string[],
): Promise<Map<string, Reaction[]>> {
  const byComment = new Map<string, Reaction[]>();
  if (commentIds.length === 0) return byComment;

  const rows = await db.select().from(reaction).where(inArray(reaction.commentId, [...commentIds]));

  const actorsByCommentAndKind = new Map<string, Map<ReactionKind, Set<Actor>>>();
  for (const row of rows) {
    const kind = narrowUnion(row.kind, reactionKindSchema.options, 'reaction.kind');
    const actor = narrowUnion(row.actor, ACTORS, 'reaction.actor');
    const byKind = actorsByCommentAndKind.get(row.commentId) ?? new Map<ReactionKind, Set<Actor>>();
    const actors = byKind.get(kind) ?? new Set<Actor>();
    actors.add(actor);
    byKind.set(kind, actors);
    actorsByCommentAndKind.set(row.commentId, byKind);
  }

  for (const [commentId, byKind] of actorsByCommentAndKind) {
    const reactions: Reaction[] = [];
    for (const kind of reactionKindSchema.options) {
      const actors = byKind.get(kind);
      if (actors === undefined) continue;
      const sorted = [...actors].sort((a, b) => (a === b ? 0 : a === 'user' ? -1 : 1));
      reactions.push({ kind, actors: sorted });
    }
    byComment.set(commentId, reactions);
  }
  return byComment;
}

/** Remove every `(agent, kind)` reaction — e.g. `eyes` working indicators left behind by runs a restart cut off. */
export async function clearAgentReactions(db: Db, kind: ReactionKind): Promise<void> {
  await db.delete(reaction).where(and(eq(reaction.actor, 'agent'), eq(reaction.kind, kind)));
}
