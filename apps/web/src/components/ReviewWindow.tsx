/**
 * The review window (SPEC §1): three panes — file tree, `CodeView`, reading
 * order — plus the header, divergence banner, staged-refresh pill, and the
 * global keymap + command palette.
 */
import { useCallback, useState } from 'react';
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

  const nextHunk = useCallback(() => {
    const top = review.codeViewRef.current?.getInstance();
    void top; // Hunk-level navigation lives inside Pierre's own scroll model;
    // exposed here as a no-op hook point until a hunk index API is wired up.
  }, [review.codeViewRef]);

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
    goSteps: () => review.toggleRightPanel(),
    openPalette: () => setPaletteOpen(true),
    nextHunk,
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
          <div className="w-80 shrink-0 border-l border-chrome-border">
            <ReadingOrderPane />
          </div>
        )}
      </div>
      <RefreshPill />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
