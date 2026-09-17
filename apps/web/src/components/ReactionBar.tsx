/**
 * Reaction pills under a comment (feature: agent reply mechanism and
 * reactions, R4). Existing reactions render as glyph+count pills; a
 * trailing `SmilePlus` opens a small Base UI popover with all six kinds.
 * Clicking a pill (or a popover glyph) toggles *the user's* reaction —
 * `actor` is always `'user'` here, since only the embedded/external agent
 * sets `actor: 'agent'` (via its own tools/CLI, not this UI).
 *
 * Pills update optimistically (`useReview().setReaction` patches local
 * state before the request resolves) and reconcile for real on the
 * `thread.updated` WS event the server dispatches after the write.
 */
import { Popover } from '@base-ui-components/react/popover';
import { SmilePlus } from 'lucide-react';
import type { Comment, ReactionKind } from '@review/core';
import { REACTIONS, glyphOf } from '../lib/reactions.ts';
import { useReview } from '../state/ReviewContext.tsx';

function actorsTitle(actors: readonly ('user' | 'agent')[]): string {
  const hasUser = actors.includes('user');
  const hasAgent = actors.includes('agent');
  if (hasUser && hasAgent) return 'you and agent';
  if (hasAgent) return 'agent';
  return 'you';
}

export function ReactionBar({ comment }: { comment: Comment }): React.JSX.Element {
  const { setReaction } = useReview();

  const toggle = (kind: ReactionKind, mine: boolean) => {
    void setReaction(comment.id, kind, !mine);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      {comment.reactions.map((r) => {
        const mine = r.actors.includes('user');
        return (
          <button
            key={r.kind}
            type="button"
            aria-pressed={mine}
            title={actorsTitle(r.actors)}
            onClick={() => toggle(r.kind, mine)}
            className={`flex h-5 items-center gap-1 rounded-full px-1.5 text-micro font-medium transition-colors ${
              mine
                ? 'bg-chrome-accent-soft text-chrome-accent'
                : 'bg-chrome-bg-sunken text-chrome-fg-muted hover:bg-chrome-bg-hover'
            }`}
          >
            <span aria-hidden>{glyphOf(r.kind)}</span>
            <span>{r.actors.length}</span>
          </button>
        );
      })}

      <Popover.Root>
        <Popover.Trigger
          aria-label="Add reaction"
          title="Add reaction"
          className="chrome-icon-btn size-5 text-chrome-fg-subtle"
        >
          <SmilePlus size={12} strokeWidth={1.75} aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={4} align="start">
            <Popover.Popup className="flex gap-0.5 rounded-md bg-chrome-bg-raised p-1 shadow-chrome ring-1 ring-chrome-fg/10">
              {REACTIONS.map(({ kind, glyph, title }) => {
                const mine = comment.reactions.some((r) => r.kind === kind && r.actors.includes('user'));
                return (
                  <Popover.Close
                    key={kind}
                    title={title}
                    aria-pressed={mine}
                    onClick={() => toggle(kind, mine)}
                    className={`flex size-7 items-center justify-center rounded text-base transition-colors hover:bg-chrome-bg-hover ${
                      mine ? 'bg-chrome-accent-soft' : ''
                    }`}
                  >
                    {glyph}
                  </Popover.Close>
                );
              })}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
