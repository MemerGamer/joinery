import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  GitBranch,
  PanelLeft,
  PanelRight,
  Rows2,
  Search,
} from 'lucide-react';
import { goHomebase } from '../lib/router.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { RevisionPicker } from './RevisionPicker.tsx';

export function Header({ onOpenPalette }: { onOpenPalette: () => void }): React.JSX.Element {
  const {
    review,
    repo,
    leftPanelOpen,
    rightPanelOpen,
    toggleLeftPanel,
    toggleRightPanel,
    diffStyle,
    setDiffStyle,
    collapseAllFiles,
    expandAllFiles,
  } = useReview();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 rounded-lg border border-chrome-border bg-chrome-bg-raised px-3">
      <button
        type="button"
        onClick={goHomebase}
        aria-label="Back to Homebase"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
      >
        <GitBranch size={16} strokeWidth={1.5} aria-hidden />
      </button>

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-body font-semibold text-chrome-fg">
          {review?.branch ?? review?.pinnedSha?.slice(0, 10) ?? '…'}
        </span>
        <span className="truncate text-micro text-chrome-fg-subtle">{repo?.rootPath}</span>
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        className="flex items-center gap-1.5 rounded-md border border-chrome-border px-2.5 py-1 text-xs text-chrome-fg-muted transition-colors hover:border-chrome-border-strong hover:bg-chrome-bg-raised hover:text-chrome-fg"
      >
        <Search size={13} strokeWidth={1.5} aria-hidden />
        Jump to…
        <kbd className="rounded border border-chrome-border-strong px-1 py-0.5 text-micro text-chrome-fg-subtle">
          ⌘K
        </kbd>
      </button>

      <RevisionPicker />

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={collapseAllFiles}
          aria-label="Collapse all files"
          title="Collapse all files"
          className="flex h-8 w-8 items-center justify-center rounded-md text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
        >
          <ChevronsDownUp size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          onClick={expandAllFiles}
          aria-label="Expand all files"
          title="Expand all files"
          className="flex h-8 w-8 items-center justify-center rounded-md text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
        >
          <ChevronsUpDown size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
          aria-pressed={diffStyle === 'split'}
          title={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
          onClick={() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')}
          className="flex h-8 w-8 items-center justify-center rounded-md text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
        >
          {diffStyle === 'split' ? (
            <Columns2 size={16} strokeWidth={1.5} aria-hidden />
          ) : (
            <Rows2 size={16} strokeWidth={1.5} aria-hidden />
          )}
        </button>
      </div>

      <div className="ml-1 flex items-center gap-0.5 border-l border-chrome-border pl-2.5">
        <button
          type="button"
          aria-label="Toggle file tree"
          aria-pressed={leftPanelOpen}
          onClick={toggleLeftPanel}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-chrome-bg-raised ${leftPanelOpen ? 'text-chrome-fg' : 'text-chrome-fg-subtle hover:text-chrome-fg'}`}
        >
          <PanelLeft size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Toggle reading order"
          aria-pressed={rightPanelOpen}
          onClick={toggleRightPanel}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-chrome-bg-raised ${rightPanelOpen ? 'text-chrome-fg' : 'text-chrome-fg-subtle hover:text-chrome-fg'}`}
        >
          <PanelRight size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </header>
  );
}
