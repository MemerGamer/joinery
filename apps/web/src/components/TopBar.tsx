/**
 * The chrome bar shared by Homebase and Explore.
 *
 * The review window's `Header` is a different component on purpose: it reads
 * `useReview()` for revision/panel/diff-style controls that only exist inside
 * a review. This is the same *frame* (the `chrome-island` shell, the 44px
 * height, `chrome-icon-btn` affordances) without that dependency, so the two
 * surfaces read as one app rather than two.
 */
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

export function TopBar({
  title,
  onBack,
  children,
}: {
  title: string;
  /** Omitted on Homebase, which is already the root of the app. */
  onBack?: () => void;
  /** Right-aligned actions. */
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="chrome-island flex h-11 shrink-0 items-center gap-1 px-2">
      {onBack !== undefined && (
        <button type="button" onClick={onBack} aria-label="Back" className="chrome-icon-btn">
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-1.5 pl-1 text-body">
        <span className="truncate font-medium text-chrome-fg">{title}</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5">{children}</div>
    </header>
  );
}
