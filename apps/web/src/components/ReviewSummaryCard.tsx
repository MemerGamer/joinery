/**
 * The card above the first file (`renderCodeViewHeader`): what the review
 * header doesn't already say — title, PR facts, CI, size, thread counts, and
 * the PR description behind a disclosure. A branch with no PR (or no `gh`)
 * shows the stats only.
 */
import type { PullDetail, PullState } from '@joinery/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Chip, CiIcon, DiffStat, type Tone } from './home/primitives.tsx';
import { Markdown } from './Markdown.tsx';

const STATE_TONE: Record<PullState, Tone> = {
  open: 'success',
  draft: 'neutral',
  merged: 'accent',
  closed: 'danger',
};

/**
 * The review's PR, fetched once and again whenever the file list refreshes.
 * Never forces a refresh: in the working revision the file list moves on every
 * save, and the server's few-minute cache keeps that from becoming a `gh` call each time.
 */
function useReviewPull(reviewId: string | undefined, refreshKey: unknown): PullDetail | null {
  const [pull, setPull] = useState<PullDetail | null>(null);

  useEffect(() => {
    if (reviewId === undefined) return;
    let cancelled = false;
    callApi('getReviewPull', { params: [reviewId], query: {} })
      .then((res) => {
        if (!cancelled) setPull(res.pull);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reviewId, refreshKey]);

  return pull;
}

export function ReviewSummaryCard(): React.JSX.Element | null {
  const { review, fileList, threads } = useReview();
  const pull = useReviewPull(review?.id, fileList);
  const [descriptionOpen, setDescriptionOpen] = useState(false);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of fileList) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
    return { additions, deletions };
  }, [fileList]);

  if (review === null) return null;

  const open = threads.filter((t) => t.status === 'open').length;
  const resolved = threads.length - open;
  const title = pull?.title ?? review.branch ?? review.pinnedSha?.slice(0, 7) ?? 'Review';
  const hasDescription = pull !== null && pull.body.trim() !== '';

  // Same footprint as a file card (ReviewCodeView's FILE_CARD_CSS): full
  // width, 10px radius, the island ring, and the 8px seam below.
  return (
    <section className="mb-2 rounded-[10px] bg-chrome-bg-raised font-sans outline outline-1 -outline-offset-1 outline-[var(--chrome-island-ring,var(--chrome-border))]">
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-chrome-fg">{title}</h2>
          {pull !== null && <span className="shrink-0 text-body tabular-nums text-chrome-fg-subtle">#{pull.number}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-chrome-fg-muted">
          {pull !== null && (
            <>
              <Chip tone={STATE_TONE[pull.state]}>{pull.state}</Chip>
              {pull.authorLogin !== null && <span>{pull.authorLogin}</span>}
              <span>
                into <span className="font-mono">{pull.baseRefName}</span>
              </span>
              {pull.ci !== null && (
                <span className="inline-flex items-center gap-1">
                  <CiIcon ci={pull.ci} />
                  {pull.ci === 'pending' ? 'CI running' : `CI ${pull.ci}`}
                </span>
              )}
            </>
          )}
          <DiffStat additions={totals.additions} deletions={totals.deletions} />
          <span className="tabular-nums">
            {fileList.length} {fileList.length === 1 ? 'file' : 'files'}
          </span>
          <span className="tabular-nums">
            {open} open · {resolved} resolved
          </span>
        </div>
      </div>
      {hasDescription && (
        <div className="border-t border-chrome-border">
          <button
            type="button"
            onClick={() => setDescriptionOpen((v) => !v)}
            aria-expanded={descriptionOpen}
            className="flex h-8 w-full items-center gap-1.5 px-3 text-xs font-medium text-chrome-fg-muted hover:text-chrome-fg"
          >
            {descriptionOpen ? (
              <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
            ) : (
              <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
            )}
            Description
          </button>
          {descriptionOpen && (
            <div className="px-4 pb-3">
              <Markdown>{pull.body}</Markdown>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
