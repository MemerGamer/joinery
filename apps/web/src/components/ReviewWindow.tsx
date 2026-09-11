/**
 * The review window (SPEC §1): three panes — file tree, `CodeView`, reading
 * order — plus the header, divergence banner, staged-refresh pill, and the
 * global keymap + command palette.
 */
import { useEffect, useRef, useState } from 'react';
import { ReviewProvider, useReview } from '../state/ReviewContext.tsx';
import { useGlobalKeymap } from '../lib/keymap.ts';
import { goHomebase } from '../lib/router.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { DivergenceBanner } from './DivergenceBanner.tsx';
import { FileTreePane } from './FileTreePane.tsx';
import { Header } from './Header.tsx';
import { ReadingOrderPane } from './ReadingOrderPane.tsx';
import { RefreshPill } from './RefreshPill.tsx';
import { ReviewCodeView } from './ReviewCodeView.tsx';

export function ReviewWindow({ reviewId }: { reviewId: string }): React.JSX.Element {
  return (
    <ReviewProvider reviewId={reviewId}>
      <ReviewWindowInner />
    </ReviewProvider>
  );
}

function ReviewWindowInner(): React.JSX.Element {
  const review = useReview();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Bug 4 fix (keymap audit, 2026-09-11): "go to steps" must OPEN the right
  // panel and focus it, not toggle it — `ReviewContext` only exposes
  // `toggleRightPanel()` (no direct setter/opener), so the minimal correct
  // fix within the files this task owns is to only call it when the panel
  // is currently closed, and to focus the panel afterwards. See
  // IMPROVEMENTS.md for the limitation this works around.
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const focusRightPanelOnOpen = useRef(false);

  useEffect(() => {
    if (review.rightPanelOpen && focusRightPanelOnOpen.current) {
      focusRightPanelOnOpen.current = false;
      rightPanelRef.current?.focus();
    }
  }, [review.rightPanelOpen]);

  useGlobalKeymap({
    toggleLeftPanel: review.toggleLeftPanel,
    toggleRightPanel: review.toggleRightPanel,
    toggleThreadsPanel: review.toggleThreadsPanel,
    toggleUnifiedSplit: () => review.setDiffStyle(review.diffStyle === 'split' ? 'unified' : 'split'),
    markViewed: () => {
      if (review.selectedPath !== null) void review.markViewed(review.selectedPath);
    },
    setRevisionWorking: () => void review.setRevision('working'),
    setRevisionHead: () => void review.setRevision('head'),
    setRevisionPr: () => void review.setRevision('pr'),
    goHomebase: () => goHomebase(),
    goSteps: () => {
      if (!review.rightPanelOpen) {
        focusRightPanelOnOpen.current = true;
        review.toggleRightPanel();
      } else {
        rightPanelRef.current?.focus();
      }
    },
    openPalette: () => setPaletteOpen(true),
    // `nextHunk` (bound to `j` in SPEC §11) has no implementation yet —
    // hunk-level navigation lives inside Pierre's own scroll model and
    // there's no hunk index API wired up. Deliberately not passed here:
    // binding `j` to a handler that only calls `preventDefault()` and does
    // nothing would be worse than not binding it at all (it would eat the
    // keystroke — including inside the guard's allowance for plain letters
    // outside text fields — while doing nothing visible). Leaving it
    // unbound means `j` is simply inert until hunk navigation exists.
    toggleFocusedFileCollapsed: () => {
      if (review.selectedPath !== null) review.toggleFileCollapsed(review.selectedPath);
    },
  });

  if (review.loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-chrome-fg-muted">
        Loading review…
      </div>
    );
  }

  if (review.error !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-chrome-fg">{review.error}</p>
        <button
          type="button"
          onClick={() => void review.reloadAll()}
          className="rounded-md border border-chrome-border px-3 py-1.5 text-xs text-chrome-fg-muted hover:bg-chrome-bg-raised"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header onOpenPalette={() => setPaletteOpen(true)} />
      {review.reviewState !== null && <DivergenceBanner state={review.reviewState} />}
      <div className="flex min-h-0 flex-1">
        {review.leftPanelOpen && (
          <div className="w-64 shrink-0 border-r border-chrome-border">
            <FileTreePane />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <ReviewCodeView />
        </div>
        {review.rightPanelOpen && (
          <div ref={rightPanelRef} tabIndex={-1} className="w-80 shrink-0 border-l border-chrome-border outline-none">
            <ReadingOrderPane />
          </div>
        )}
      </div>
      <RefreshPill />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
