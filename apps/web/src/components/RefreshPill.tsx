/**
 * "N files updated · Refresh" (SPEC §5). Refresh is staged, never automatic
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
      className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-chrome-border-strong bg-chrome-bg-raised px-3 py-2 text-xs font-medium text-chrome-fg shadow-[var(--chrome-shadow)] transition-colors hover:bg-chrome-bg-sunken active:bg-chrome-bg"
    >
      <RefreshCw size={14} strokeWidth={1.5} aria-hidden />
      {pendingCount} file{pendingCount === 1 ? '' : 's'} updated · Refresh
    </button>
  );
}
