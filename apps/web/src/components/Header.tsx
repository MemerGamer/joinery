import { Columns2, GitBranch, PanelLeft, PanelRight, Rows2, Search } from 'lucide-react';
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
  } = useReview();

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-chrome-border bg-chrome-bg px-3">
      <button
        type="button"
        onClick={goHomebase}
        aria-label="Back to Homebase"
        className="rounded-md p-1.5 text-chrome-fg-muted hover:bg-chrome-bg-raised"
      >
        <GitBranch size={16} strokeWidth={1.5} aria-hidden />
      </button>

      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate font-medium text-chrome-fg">
          {review?.branch ?? review?.pinnedSha?.slice(0, 10) ?? '…'}
        </span>
        <span className="truncate text-chrome-fg-subtle">{repo?.rootPath}</span>
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        className="flex items-center gap-2 rounded-md border border-chrome-border px-2.5 py-1.5 text-xs text-chrome-fg-muted hover:bg-chrome-bg-raised"
      >
        <Search size={14} strokeWidth={1.5} aria-hidden />
        Jump to…
        <kbd className="rounded border border-chrome-border-strong px-1 text-[10px]">⌘K</kbd>
      </button>

      <RevisionPicker />

      <button
        type="button"
        aria-label={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
        aria-pressed={diffStyle === 'split'}
        onClick={() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')}
        className="rounded-md p-1.5 text-chrome-fg-muted hover:bg-chrome-bg-raised"
      >
        {diffStyle === 'split' ? (
          <Columns2 size={16} strokeWidth={1.5} aria-hidden />
        ) : (
          <Rows2 size={16} strokeWidth={1.5} aria-hidden />
        )}
      </button>

      <ThemePicker />

      <button
        type="button"
        aria-label="Toggle file tree"
        aria-pressed={leftPanelOpen}
        onClick={toggleLeftPanel}
        className={`rounded-md p-1.5 hover:bg-chrome-bg-raised ${leftPanelOpen ? 'text-chrome-fg' : 'text-chrome-fg-subtle'}`}
      >
        <PanelLeft size={16} strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Toggle reading order"
        aria-pressed={rightPanelOpen}
        onClick={toggleRightPanel}
        className={`rounded-md p-1.5 hover:bg-chrome-bg-raised ${rightPanelOpen ? 'text-chrome-fg' : 'text-chrome-fg-subtle'}`}
      >
        <PanelRight size={16} strokeWidth={1.5} aria-hidden />
      </button>
    </header>
  );
}
