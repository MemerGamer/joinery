/**
 * The review window: three panes — file tree, `CodeView`, reading
 * order — plus the header, divergence banner, staged-refresh pill, and the
 * global keymap + command palette.
 */
import { useCallback, useState } from 'react';
import { ReviewProvider, useReview } from '../state/ReviewContext.tsx';
import { useReviewShortcuts } from '../state/useReviewShortcuts.ts';
import { useGlobalKeymap } from '../lib/keymap.ts';
import { useResizableWidth } from '../lib/useResizableWidth.ts';
import { goHomebase } from '../lib/router.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { DivergenceBanner } from './DivergenceBanner.tsx';
import { FileTreePane } from './FileTreePane.tsx';
import { Header } from './Header.tsx';
import { ReadingOrderPane } from './ReadingOrderPane.tsx';
import { RefreshPill } from './RefreshPill.tsx';
import { ResizeHandle } from './ResizeHandle.tsx';
import { ReviewCodeView } from './ReviewCodeView.tsx';
import { ShortcutHelp } from './ShortcutHelp.tsx';

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
  // Which view the palette should land on when it opens. `undefined` is the
  // root jump-to view (Cmd+K); Cmd+P and Cmd+Shift+P pin it to Files and
  // Commands respectively. Set before opening so the palette adopts it on the
  // same open, and re-set on every shortcut so a repeat press can switch views
  // even while the palette is already up.
  const [paletteMode, setPaletteMode] = useState<'command' | 'file' | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const shortcuts = useReviewShortcuts();

  const openPaletteIn = (nextMode: 'command' | 'file' | undefined) => {
    setPaletteMode(nextMode);
    setPaletteOpen(true);
  };

  // Widths are per-side, independently persisted, so resizing one panel
  // never disturbs the other's remembered size.
  const leftPanel = useResizableWidth('left', { defaultWidth: 256, min: 180, max: 560 });
  const rightPanel = useResizableWidth('right', { defaultWidth: 320, min: 220, max: 640 });

  useGlobalKeymap({
    // j/k, n/p, ]/[, c, r, e/Shift+E — see state/useReviewShortcuts.ts.
    ...shortcuts,
    showHelp: () => setHelpOpen((v) => !v),
    toggleLeftPanel: review.toggleLeftPanel,
    toggleRightPanel: review.toggleRightPanel,
    toggleThreadsPanel: review.toggleThreadsPanel,
    toggleComments: review.toggleComments,
    toggleUnifiedSplit: () => review.setDiffStyle(review.diffStyle === 'split' ? 'unified' : 'split'),
    setRevisionWorking: () => void review.setRevision('working'),
    setRevisionHead: () => void review.setRevision('head'),
    setRevisionPr: () => void review.setRevision('pr'),
    goHomebase: () => goHomebase(),
    openPalette: () => openPaletteIn(undefined),
    openPaletteFiles: () => openPaletteIn('file'),
    openPaletteCommands: () => openPaletteIn('command'),
    toggleFocusedFileCollapsed: () => {
      if (review.selectedPath !== null) review.toggleFileCollapsed(review.selectedPath);
    },
  });

  if (review.loading) {
    return (
      <div className="flex h-full items-center justify-center text-body text-chrome-fg-muted">
        Loading review…
      </div>
    );
  }

  if (review.error !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-body font-medium text-chrome-fg">{review.error}</p>
        <button
          type="button"
          onClick={() => void review.reloadAll()}
          className="chrome-btn"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 bg-chrome-bg-sunken p-2">
      {/*
       * Islands layout: every region — header, divergence banner, file
       * tree, diff pane, reading order — is its own rounded, bordered box
       * floating on the sunken shell background, with a gap (rather than a
       * shared 1px border) marking the seam.
       *
       * One spacing rule governs the whole shell: `gap-2`/`p-2` (8px) is the
       * only source of separation, declared once on this outer flex column,
       * so every seam — header-to-edge, header-to-banner-or-row, and
       * island-to-island alike — is the same 8px and stays that way as
       * panels (or the banner) toggle. The islands row below adds no padding
       * of its own; it only contributes its own inter-island `gap-2`. The
       * resize handles are absolutely positioned inside each panel's wrapper
       * (see ResizeHandle) precisely so they can't contribute width here.
       */}
      <Header onOpenPalette={() => openPaletteIn(undefined)} />
      {review.reviewState !== null && <DivergenceBanner state={review.reviewState} />}
      <div className="flex min-h-0 flex-1 gap-2">
        {review.leftPanelOpen && (
          // `relative` (and no `overflow-hidden`) on the wrapper so the
          // handle can overhang into the seam; the rounded/clipping box is
          // the inner element.
          <div className="relative shrink-0" style={{ width: leftPanel.width }}>
            <div className="chrome-island h-full">
              <FileTreePane />
            </div>
            <ResizeHandle side="right" aria-label="Resize file tree panel" {...leftPanel.handleProps} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          {/* No island here: each file renders as its own card (see FILE_CARD_CSS in ReviewCodeView.tsx). */}
          <ReviewCodeView />
        </div>
        {review.rightPanelOpen && (
          <div className="relative shrink-0" style={{ width: rightPanel.width }}>
            <ResizeHandle side="left" aria-label="Resize reading order panel" {...rightPanel.handleProps} />
            <div className="chrome-island h-full">
              <ReadingOrderPane />
            </div>
          </div>
        )}
      </div>
      <RefreshPill />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialMode={paletteMode} />
      <ShortcutHelp open={helpOpen} onClose={closeHelp} />
    </div>
  );
}
