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
import { ThemePicker } from './ThemePicker.tsx';

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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-chrome-border bg-chrome-bg px-4">
      <button
        type="button"
        onClick={goHomebase}
        aria-label="Back to Homebase"
        className="rounded-md p-2 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
      >
        <GitBranch size={16} strokeWidth={1.5} aria-hidden />
      </button>

      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate font-semibold text-chrome-fg">
          {review?.branch ?? review?.pinnedSha?.slice(0, 10) ?? '…'}
        </span>
        <span className="truncate text-xs text-chrome-fg-subtle">{repo?.rootPath}</span>
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        className="flex items-center gap-2 rounded-md border border-chrome-border px-3 py-1.5 text-xs text-chrome-fg-muted transition-colors hover:border-chrome-border-strong hover:bg-chrome-bg-raised hover:text-chrome-fg"
      >
        <Search size={14} strokeWidth={1.5} aria-hidden />
        Jump to…
        <kbd className="rounded border border-chrome-border-strong px-1.5 py-0.5 text-[10px] text-chrome-fg-subtle">
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
          className="rounded-md p-2 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
        >
          <ChevronsDownUp size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          onClick={expandAllFiles}
          aria-label="Expand all files"
          title="Expand all files"
          className="rounded-md p-2 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
        >
          <ChevronsUpDown size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>

      <button
        type="button"
        aria-label={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
        aria-pressed={diffStyle === 'split'}
        onClick={() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')}
        className="rounded-md p-2 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-raised hover:text-chrome-fg active:bg-chrome-bg-sunken"
      >
        {diffStyle === 'split' ? (
          <Columns2 size={16} strokeWidth={1.5} aria-hidden />
        ) : (
          <Rows2 size={16} strokeWidth={1.5} aria-hidden />
        )}
      </button>

      <ThemePicker />

      <div className="ml-1 flex items-center gap-1 border-l border-chrome-border pl-3">
        <button
          type="button"
          aria-label="Toggle file tree"
          aria-pressed={leftPanelOpen}
          onClick={toggleLeftPanel}
          className={`rounded-md p-2 transition-colors hover:bg-chrome-bg-raised ${leftPanelOpen ? 'text-chrome-fg' : 'text-chrome-fg-subtle hover:text-chrome-fg'}`}
        >
          <PanelLeft size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Toggle reading order"
          aria-pressed={rightPanelOpen}
          onClick={toggleRightPanel}
          className={`rounded-md p-2 transition-colors hover:bg-chrome-bg-raised ${rightPanelOpen ? 'text-chrome-fg' : 'text-chrome-fg-subtle hover:text-chrome-fg'}`}
        >
          <PanelRight size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </header>
  );
}
