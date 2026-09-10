/**
 * The revision picker (SPEC §1, §4): switches `working`/`head`/`pr`, showing
 * only revisions that currently exist.
 */
import type { Revision } from '@review/core';
import { useReview } from '../state/ReviewContext.tsx';

const LABELS: Record<Revision, string> = { working: 'Working', head: 'Head', pr: 'PR' };

export function RevisionPicker(): React.JSX.Element | null {
  const { reviewState, setRevision } = useReview();
  if (reviewState === null) return null;

  return (
    <div role="radiogroup" aria-label="Revision" className="flex items-center gap-0.5 rounded-md bg-chrome-bg-sunken p-0.5">
      {reviewState.availableRevisions.map((rev) => {
        const active = rev === reviewState.currentRevision;
        return (
          <button
            key={rev}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => void setRevision(rev)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              active
                ? 'bg-chrome-bg text-chrome-fg shadow-[var(--chrome-shadow)]'
                : 'text-chrome-fg-muted hover:text-chrome-fg'
            }`}
          >
            {LABELS[rev]}
          </button>
        );
      })}
    </div>
  );
}
