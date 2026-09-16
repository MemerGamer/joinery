import {
  ArrowLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  MessageSquare,
  MessageSquareOff,
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
    commentsVisible,
    toggleComments,
  } = useReview();

  const repoName = repo?.rootPath.split('/').filter(Boolean).at(-1);

  return (
    <header className="chrome-island flex h-11 shrink-0 items-center gap-1 px-2">
      <button type="button" onClick={goHomebase} aria-label="Back to Homebase" className="chrome-icon-btn">
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
      </button>

      {/* Breadcrumb: repo › branch. The full path is a tooltip, not a second
          line of tiny text competing with the branch name. */}
      <div className="flex min-w-0 items-center gap-1.5 pl-1 text-body" title={repo?.rootPath}>
        {repoName !== undefined && (
          <>
            <span className="truncate text-chrome-fg-muted">{repoName}</span>
            <span className="text-chrome-fg-subtle" aria-hidden>
              /
            </span>
          </>
        )}
        <span className="truncate font-medium text-chrome-fg">
          {review?.branch ?? review?.pinnedSha?.slice(0, 10) ?? '…'}
        </span>
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Jump to file, step, or command"
        title="Jump to… (⌘K)"
        className="chrome-icon-btn"
      >
        <Search size={15} strokeWidth={1.75} aria-hidden />
      </button>

      <div className="mx-1.5 h-4 w-px bg-chrome-border-strong opacity-60" aria-hidden />

      <RevisionPicker />

      <div className="mx-1.5 h-4 w-px bg-chrome-border-strong opacity-60" aria-hidden />

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={collapseAllFiles}
          aria-label="Collapse all files"
          title="Collapse all files"
          className="chrome-icon-btn"
        >
          <ChevronsDownUp size={15} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          onClick={expandAllFiles}
          aria-label="Expand all files"
          title="Expand all files"
          className="chrome-icon-btn"
        >
          <ChevronsUpDown size={15} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
          title={diffStyle === 'split' ? 'Switch to unified diff' : 'Switch to split diff'}
          onClick={() => setDiffStyle(diffStyle === 'split' ? 'unified' : 'split')}
          className="chrome-icon-btn"
        >
          {diffStyle === 'split' ? (
            <Columns2 size={15} strokeWidth={1.75} aria-hidden />
          ) : (
            <Rows2 size={15} strokeWidth={1.75} aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label={commentsVisible ? 'Hide comments' : 'Show comments'}
          title={commentsVisible ? 'Hide comments (Shift+C)' : 'Show comments (Shift+C)'}
          aria-pressed={commentsVisible}
          onClick={toggleComments}
          className={`chrome-icon-btn ${commentsVisible ? '' : 'text-chrome-fg-subtle'}`}
        >
          {commentsVisible ? (
            <MessageSquare size={15} strokeWidth={1.75} aria-hidden />
          ) : (
            <MessageSquareOff size={15} strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </div>

      <div className="mx-1.5 h-4 w-px bg-chrome-border-strong opacity-60" aria-hidden />

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Toggle file tree"
          title="Toggle file tree"
          aria-pressed={leftPanelOpen}
          onClick={toggleLeftPanel}
          className={`chrome-icon-btn ${leftPanelOpen ? '' : 'text-chrome-fg-subtle'}`}
        >
          <PanelLeft size={15} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Toggle reading order"
          title="Toggle reading order"
          aria-pressed={rightPanelOpen}
          onClick={toggleRightPanel}
          className={`chrome-icon-btn ${rightPanelOpen ? '' : 'text-chrome-fg-subtle'}`}
        >
          <PanelRight size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </header>
  );
}
