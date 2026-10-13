/**
 * "N files updated · Refresh". Refresh is staged, never automatic
 * in place — applying is a click, never something that happens under the
 * cursor.
 */
import { RefreshCw } from 'lucide-react';
import { useReview } from '../state/ReviewContext.tsx';

export function RefreshPill(): React.JSX.Element | null {
  const { pendingCount, applyPendingRefresh } = useReview();
  if (pendingCount === 0) return null;

  return (
    <button
      type="button"
      onClick={applyPendingRefresh}
      className="fixed bottom-5 left-1/2 z-30 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full bg-chrome-bg-raised ring-1 ring-chrome-fg/10 pl-3 pr-3.5 text-xs font-medium text-chrome-fg shadow-chrome transition-colors hover:bg-[linear-gradient(var(--chrome-bg-hover),var(--chrome-bg-hover))]"
    >
      <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
      <span className="text-chrome-fg-muted">
        {pendingCount} file{pendingCount === 1 ? '' : 's'} updated
      </span>
      <span className="text-chrome-accent">Refresh</span>
    </button>
  );
}
