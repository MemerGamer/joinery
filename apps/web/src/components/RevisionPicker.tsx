/**
 * The revision picker: switches `working`/`head`/`pr`, showing
 * only revisions that currently exist.
 */
import { Radio } from '@base-ui-components/react/radio';
import { RadioGroup } from '@base-ui-components/react/radio-group';
import { useEffect, useState } from 'react';
import type { HeadSource, Revision } from '@joinery/core';
import { useReview } from '../state/ReviewContext.tsx';
import { Hint } from './controls.tsx';

const LABELS: Record<Revision, string> = { working: 'Working', head: 'Head', pr: 'PR' };

/**
 * Silently changing what `head` means is forbidden, so when it was
 * resolved from anything other than the checkout or local branch, the button
 * says which rung answered (`ReviewState.headSource`). `worktree`/`local` are
 * the expected case and get no suffix — the label only speaks up when the
 * meaning shifted.
 */
const HEAD_SOURCE_SUFFIX: Record<HeadSource, string | null> = {
  worktree: null,
  local: null,
  remote: 'origin',
  'pinned-sha': 'pinned',
  pin: 'pinned',
};

const HEAD_SOURCE_TITLE: Record<HeadSource, string> = {
  worktree: 'Head of the attached worktree',
  local: 'Tip of the local branch',
  remote: 'No local branch — tip of the remote-tracking branch on origin',
  'pinned-sha': 'The commit this review was pinned to',
  pin: 'The branch is gone — the last commit this review saw',
};

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
    <RadioGroup
      aria-label="Revision"
      value={selected}
      onValueChange={(rev) => void setRevision(rev as Revision)}
      className="flex items-center gap-1"
    >
      {reviewState.availableRevisions.map((rev) => {
        const pending = rev === pendingRevision;
        const source = rev === 'head' ? reviewState.headSource : null;
        const suffix = source === null ? null : HEAD_SOURCE_SUFFIX[source];
        return (
          <Hint key={rev} label={source === null ? undefined : HEAD_SOURCE_TITLE[source]}>
            <Radio.Root
              value={rev}
              // Tied to the real pending state, not the delayed sweep: the
              // switch is in flight either way, and the animation is decorative.
              aria-busy={pending}
              className={`flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-chrome-fg-muted transition-colors not-data-checked:hover:bg-chrome-bg-hover not-data-checked:hover:text-chrome-fg data-checked:bg-chrome-bg-active data-checked:text-chrome-fg ${
                pending && sweeping ? 'chrome-sweep' : ''
              }`}
            >
              {LABELS[rev]}
              {suffix !== null && <span className="font-normal text-chrome-fg-subtle">{suffix}</span>}
            </Radio.Root>
          </Hint>
        );
      })}
    </RadioGroup>
  );
}
