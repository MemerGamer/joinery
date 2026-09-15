/**
 * The review window (SPEC §1): three panes — file tree, `CodeView`, reading
 * order — plus the header, divergence banner, staged-refresh pill, and the
 * global keymap + command palette.
 */
import { useEffect, useRef, useState } from 'react';
import { ReviewProvider, useReview } from '../state/ReviewContext.tsx';
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

  const openPaletteIn = (nextMode: 'command' | 'file' | undefined) => {
    setPaletteMode(nextMode);
    setPaletteOpen(true);
  };

  // "Go to steps" is an open intent, not a toggle intent: it should always
  // land on the right panel, focused, regardless of the panel's current
  // state. `setRightPanelOpen(true)` below is idempotent, so this effect
  // only needs to focus once the panel is actually open — immediately if it
  // was already open, or after it mounts if this call is what opened it.
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const focusRightPanelOnOpen = useRef(false);

  // Widths are per-side, independently persisted, so resizing one panel
  // never disturbs the other's remembered size.
  const leftPanel = useResizableWidth('left', { defaultWidth: 256, min: 180, max: 560 });
  const rightPanel = useResizableWidth('right', { defaultWidth: 320, min: 220, max: 640 });

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
    // GitHub's `v` toggles rather than only marks, and the header checkbox
    // it mirrors is a checkbox — so this has to clear the check too.
    markViewed: () => {
      if (review.selectedPath !== null) void review.toggleViewed(review.selectedPath);
    },
    setRevisionWorking: () => void review.setRevision('working'),
    setRevisionHead: () => void review.setRevision('head'),
    setRevisionPr: () => void review.setRevision('pr'),
    goHomebase: () => goHomebase(),
    goSteps: () => {
      if (review.rightPanelOpen) {
        rightPanelRef.current?.focus();
      } else {
        focusRightPanelOnOpen.current = true;
        review.setRightPanelOpen(true);
      }
    },
    openPalette: () => openPaletteIn(undefined),
    openPaletteFiles: () => openPaletteIn('file'),
    openPaletteCommands: () => openPaletteIn('command'),
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
          className="rounded-md border border-chrome-border px-3 py-1.5 text-xs text-chrome-fg-muted hover:bg-chrome-bg-raised"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 bg-chrome-bg-sunken p-2">
      {/*
       * Islands layout (SPEC): every region — header, divergence banner, file
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
            <div className="h-full overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg-raised">
              <FileTreePane />
            </div>
            <ResizeHandle side="right" aria-label="Resize file tree panel" {...leftPanel.handleProps} />
          </div>
        )}
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg-raised">
          <ReviewCodeView />
        </div>
        {review.rightPanelOpen && (
          <div className="relative shrink-0" style={{ width: rightPanel.width }}>
            <ResizeHandle side="left" aria-label="Resize reading order panel" {...rightPanel.handleProps} />
            <div
              ref={rightPanelRef}
              tabIndex={-1}
              // No `outline-none` here: `tabIndex={-1}` keeps the panel out of
              // normal tab order (it's a "go to steps" landing target, not a
              // stop a Tab press should ever reach), but the global
              // `:focus-visible` rule (styles/index.css) still needs to draw
              // when the shortcut moves focus here — that's the only way a
              // keyboard user can tell the shortcut did anything. It's not a
              // "permanent box": `:focus-visible` only paints while this
              // element actually holds focus, and clears the instant focus
              // moves on.
              className="h-full overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg-raised"
            >
              <ReadingOrderPane />
            </div>
          </div>
        )}
      </div>
      <RefreshPill />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialMode={paletteMode} />
    </div>
  );
}
