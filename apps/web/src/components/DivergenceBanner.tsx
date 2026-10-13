/**
 * The divergence treatment. `0 N` (remote ahead) is the worst failure mode
 * of a local-first reviewer — commenting on code that's already been
 * rewritten — so it is a loud banner, never a subtle indicator.
 *
 * Rendered as its own island (rounded-lg, bordered) rather than merged into
 * the header: it's conditional and the header is a fixed 48px control strip,
 * so folding a variable-height alert into it would either clip the message
 * or make the header's height breathe. As a sibling in the shell's
 * `flex-col gap-2`, it sits on the same 8px grid automatically — appearing
 * or disappearing only ever changes which gap exists, never its size.
 */
import { AlertTriangle, GitCompare } from 'lucide-react';
import type { ReviewState } from '@joinery/core';

export function DivergenceBanner({ state }: { state: ReviewState }): React.JSX.Element | null {
  const { divergence, basesMismatched, operationInProgress } = state;

  if (operationInProgress !== null) {
    return (
      <div
        role="status"
        className="chrome-island flex items-center gap-2 px-3 py-1.5 text-xs text-chrome-fg-muted"
      >
        <GitCompare size={14} strokeWidth={1.5} className="shrink-0" aria-hidden />
        {operationInProgress} in progress — showing the last good snapshot.
      </div>
    );
  }

  if (divergence === null) return null;
  const { ahead, behind } = divergence;
  if (ahead === 0 && behind === 0) return null;

  if (behind > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-lg bg-chrome-danger-bg px-3 py-2 text-xs font-medium text-chrome-fg"
      >
        <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0 text-chrome-danger" aria-hidden />
        {ahead > 0
          ? `Diverged from the remote — you're ahead by ${ahead} and behind by ${behind}. This review may not reflect the latest pushed code.`
          : `The remote is ${behind} commit${behind === 1 ? '' : 's'} ahead — you are reviewing stale code.`}
        {basesMismatched && ' The comparison base has also moved and needs a full recompute.'}
      </div>
    );
  }

  return (
    <div className="chrome-island flex items-center gap-2 px-3 py-1.5 text-xs text-chrome-fg-muted">
      <GitCompare size={14} strokeWidth={1.5} className="shrink-0" aria-hidden />
      {ahead} unpushed commit{ahead === 1 ? '' : 's'}
    </div>
  );
}
