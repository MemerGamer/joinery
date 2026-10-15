/**
 * Reactions on a comment (feature: agent reply mechanism and reactions,
 * R4). `ReactionBar` renders the existing reactions as glyph+count pills
 * under the body; `ReactionPicker` is the `SmilePlus` button that lives in
 * the comment header beside delete, and opens a small Base UI popover with all six kinds,
 * beside the trigger so it doesn't cover the comment below.
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
import type { Comment, ReactionKind } from '@joinery/core';
import { REACTIONS, glyphOf } from '../lib/reactions.ts';

const TITLE_BY_KIND = new Map(REACTIONS.map((r) => [r.kind, r.title]));
import { useReview } from '../state/ReviewContext.tsx';

function actorsTitle(actors: readonly ('user' | 'agent')[]): string {
  const hasUser = actors.includes('user');
  const hasAgent = actors.includes('agent');
  if (hasUser && hasAgent) return 'you and agent';
  if (hasAgent) return 'agent';
  return 'you';
}

export function ReactionBar({ comment }: { comment: Comment }): React.JSX.Element | null {
  const { setReaction } = useReview();
  if (comment.reactions.length === 0) return null;

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
            aria-label={`${glyphOf(r.kind)} ${TITLE_BY_KIND.get(r.kind) ?? r.kind}: ${String(r.actors.length)} (${actorsTitle(r.actors)})`}
            title={actorsTitle(r.actors)}
            onClick={() => toggle(r.kind, mine)}
            // Text colours carry `!`: the unlayered global `button { color: inherit }`
            // in styles/index.css otherwise beats layered Tailwind utilities.
            className={`flex h-5 items-center gap-1 rounded-full px-1.5 text-micro font-medium transition-colors ${
              mine
                ? 'bg-chrome-accent-soft text-chrome-accent!'
                : 'bg-chrome-bg-sunken text-chrome-fg-muted! hover:bg-chrome-bg-hover'
            }`}
          >
            <span aria-hidden>{glyphOf(r.kind)}</span>
            <span>{r.actors.length}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ReactionPicker({ comment }: { comment: Comment }): React.JSX.Element {
  const { setReaction } = useReview();

  const toggle = (kind: ReactionKind, mine: boolean) => {
    void setReaction(comment.id, kind, !mine);
  };

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Add reaction"
        title="Add reaction"
        className="chrome-icon-btn size-5 text-chrome-fg-subtle"
      >
        <SmilePlus size={12} strokeWidth={1.75} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        {/* Opens beside the trigger, level with the reaction row, so it never
            lands on the next comment's author line; collision handling flips
            it when there's no room. Escape / outside click close it (Base UI). */}
        <Popover.Positioner side="right" align="center" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup
            aria-label="Add reaction"
            data-reaction-picker=""
            className="flex gap-0.5 rounded-lg border border-chrome-border-strong bg-chrome-bg-raised p-0.5 shadow-[0_6px_20px_light-dark(rgba(20,22,30,0.14),rgba(0,0,0,0.55)),0_1px_3px_light-dark(rgba(20,22,30,0.08),rgba(0,0,0,0.4))] outline-hidden"
          >
            {REACTIONS.map(({ kind, glyph, title }) => {
              const mine = comment.reactions.some((r) => r.kind === kind && r.actors.includes('user'));
              return (
                <Popover.Close
                  key={kind}
                  title={title}
                  aria-label={`${mine ? 'Remove' : 'React with'} ${glyph} ${title}`}
                  aria-pressed={mine}
                  onClick={() => toggle(kind, mine)}
                  className={`flex size-7 items-center justify-center rounded-md text-base transition-colors hover:bg-chrome-bg-hover ${
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
  );
}
