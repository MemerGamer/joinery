import {
  ArrowLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  GitMerge,
  Loader2,
  MessageSquare,
  MessageSquareOff,
  Play,
  Rows2,
  Search,
} from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../lib/apiClient.ts';
import { goHomebase } from '../lib/router.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Chip } from './home/primitives.tsx';
import { RevisionPicker } from './RevisionPicker.tsx';

/**
 * "Start review" / "Reopen review" — moves a `draft`/`archived` review to
 * `open`. Hidden for `open`/`orphaned`. Its
 * in-flight and error state are local rather than in `ReviewContext`: a
 * failed status flip doesn't belong in `state.error` (that's "the review
 * failed to load"), and nothing else needs to know about it.
 */
function StartReviewButton({ status }: { status: 'draft' | 'archived' }): React.JSX.Element {
  const { startReview } = useReview();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      await startReview();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start review');
    } finally {
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={starting}
      title={error ?? undefined}
      className="chrome-btn-primary ml-2"
    >
      {starting ? (
        <Loader2 size={13} strokeWidth={1.75} className="animate-spin" aria-hidden />
      ) : (
        <Play size={13} strokeWidth={1.75} aria-hidden />
      )}
      {status === 'archived' ? 'Reopen review' : 'Start review'}
    </button>
  );
}

/**
 * Same frame + divider as lucide's `PanelLeft`/`PanelRight`, but the open
 * state is read from a solid sidebar rather than a direction arrow — an
 * arrow reads as "click to move this way," which is backwards half the
 * time (opening the *left* panel means the content the arrow points at
 * doesn't exist yet). A filled-vs-hollow sidebar reads as pure state, no
 * direction implied.
 */
function PanelToggleIcon({
  side,
  filled,
}: {
  side: 'left' | 'right';
  filled: boolean;
}): React.JSX.Element {
  const dividerX = side === 'left' ? 9 : 15;
  const sidebarX = side === 'left' ? 4 : 15;
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="18" height="18" x="3" y="3" rx="3" />
      <path d={`M${dividerX} 3v18`} />
      {filled && <rect width="5" height="16" x={sidebarX} y="4" rx="1.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function Header({ onOpenPalette }: { onOpenPalette: () => void }): React.JSX.Element {
  const {
    review,
    reviewState,
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
        {reviewState?.merged === true && review !== null && (
          <Chip
            tone="accent"
            icon={<GitMerge size={11} strokeWidth={2} aria-hidden />}
            title={`The branch is gone and its commits are in ${review.baseRef}`}
          >
            Merged into {review.baseRef}
          </Chip>
        )}
      </div>

      {/* Nothing left to start on once the branch has landed. */}
      {(review?.status === 'draft' || review?.status === 'archived') && reviewState?.merged !== true && (
        <StartReviewButton status={review.status} />
      )}

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
          <PanelToggleIcon side="left" filled={leftPanelOpen} />
        </button>
        <button
          type="button"
          aria-label="Toggle reading order"
          title="Toggle reading order"
          aria-pressed={rightPanelOpen}
          onClick={toggleRightPanel}
          className={`chrome-icon-btn ${rightPanelOpen ? '' : 'text-chrome-fg-subtle'}`}
        >
          <PanelToggleIcon side="right" filled={rightPanelOpen} />
        </button>
      </div>
    </header>
  );
}
