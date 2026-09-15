/**
 * The revision picker (SPEC §1, §4): switches `working`/`head`/`pr`, showing
 * only revisions that currently exist.
 */
import { useEffect, useState } from 'react';
import type { Revision } from '@review/core';
import { useReview } from '../state/ReviewContext.tsx';

const LABELS: Record<Revision, string> = { working: 'Working', head: 'Head', pr: 'PR' };

/**
 * How long a switch has to stay pending before the sweep appears. Most
 * switches resolve well inside this, and a sweep that flashes for 200ms
 * reads as a glitch rather than as progress — so the animation is for the
 * slow case only, while the selected-button repaint (which is instant) does
 * the work of acknowledging the click.
 */
const SWEEP_DELAY_MS = 1000;

export function RevisionPicker(): React.JSX.Element | null {
  const { reviewState, pendingRevision, setRevision } = useReview();

  const [sweeping, setSweeping] = useState(false);
  useEffect(() => {
    setSweeping(false);
    if (pendingRevision === null) return;
    // Re-running on every `pendingRevision` change restarts the clock, so
    // clicking around quickly keeps deferring the sweep rather than
    // inheriting the first click's elapsed time.
    const timer = window.setTimeout(() => setSweeping(true), SWEEP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pendingRevision]);

  if (reviewState === null) return null;

  // Selection follows the click, not the round trip: a pending switch paints
  // as selected right away, and picks up the sweep if its files are still
  // out after `SWEEP_DELAY_MS`.
  const selected = pendingRevision ?? reviewState.currentRevision;

  return (
    <div
      role="radiogroup"
      aria-label="Revision"
      className="flex items-center gap-0.5 rounded-md bg-chrome-bg-sunken p-1"
    >
      {reviewState.availableRevisions.map((rev) => {
        const active = rev === selected;
        const pending = rev === pendingRevision;
        return (
          <button
            key={rev}
            type="button"
            role="radio"
            aria-checked={active}
            // Tied to the real pending state, not the delayed sweep: the
            // switch is in flight either way, and the animation is decorative.
            aria-busy={pending}
            onClick={() => void setRevision(rev)}
            className={`cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-chrome-bg text-chrome-fg shadow-[var(--chrome-shadow)]'
                : 'text-chrome-fg-muted hover:text-chrome-fg'
            } ${pending && sweeping ? 'chrome-sweep' : ''}`}
          >
            {LABELS[rev]}
          </button>
        );
      })}
    </div>
  );
}
