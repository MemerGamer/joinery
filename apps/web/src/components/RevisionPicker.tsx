/**
 * The revision picker (SPEC §1, §4): switches `working`/`head`/`pr`, showing
 * only revisions that currently exist.
 */
import type { Revision } from '@review/core';
import { useReview } from '../state/ReviewContext.tsx';

const LABELS: Record<Revision, string> = { working: 'Working', head: 'Head', pr: 'PR' };

export function RevisionPicker(): React.JSX.Element | null {
  const { reviewState, pendingRevision, setRevision } = useReview();
  if (reviewState === null) return null;

  // Selection follows the click, not the round trip: a pending switch paints
  // as selected right away and carries a sweep until its files land, so the
  // picker never looks inert while the server is working.
  const selected = pendingRevision ?? reviewState.currentRevision;

  return (
    <div
      role="radiogroup"
      aria-label="Revision"
      className="flex items-center gap-0.5 rounded-md bg-chrome-bg-sunken p-1"
    >
      {reviewState.availableRevisions.map((rev) => {
        const active = rev === selected;
        const loading = rev === pendingRevision;
        return (
          <button
            key={rev}
            type="button"
            role="radio"
            aria-checked={active}
            // The sweep is decorative; screen readers get the state change
            // from `aria-busy` rather than from the animated overlay.
            aria-busy={loading}
            onClick={() => void setRevision(rev)}
            className={`cursor-pointer rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-chrome-bg text-chrome-fg shadow-[var(--chrome-shadow)]'
                : 'text-chrome-fg-muted hover:text-chrome-fg'
            } ${loading ? 'chrome-sweep' : ''}`}
          >
            {LABELS[rev]}
          </button>
        );
      })}
    </div>
  );
}
