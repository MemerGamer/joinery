/**
 * Homebase (SPEC §1): one row per branch across registered repos, each row
 * showing what's waiting on you — open threads, viewed files, whether a
 * reading order exists, an agent in flight.
 *
 * Deliberately DB-only: the row data is `GET /api/reviews`' summaries, which
 * are `GROUP BY review_id` aggregates, never per-review engine state. The
 * moment a row wants "4 files changed" every listed review needs a live
 * engine, which is exactly the fan-out the engine's idle eviction exists to
 * avoid.
 *
 * Same shell as the review window — sunken background, top bar island,
 * islands on one 8px gap — but the column is capped at a reading width and
 * centred: a dashboard of two-line rows stretched across a 1600px monitor
 * is mostly empty space. The repo rail on the left is both a filter and a
 * per-repo tally, and mirrors Explore's rail so the two screens rhyme.
 */
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  Compass,
  GitBranch,
  GitPullRequest,
  Layers,
  ListOrdered,
  Loader2,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goExplore, goReview } from '../lib/router.ts';
import { TopBar } from './TopBar.tsx';
import type { Repo, Review, ReviewSummary } from '@review/core';

type Tab = 'active' | 'archived';

/** `null` is "all repositories". */
type RepoFilter = string | null;

function repoName(repo: Repo): string {
  return repo.rootPath.split('/').filter(Boolean).at(-1) ?? repo.rootPath;
}

const EMPTY_SUMMARY: Omit<ReviewSummary, 'reviewId'> = {
  openThreads: 0,
  resolvedThreads: 0,
  viewedFiles: 0,
  readingOrderVersion: null,
  agentRunning: false,
  lastActivityAt: null,
};

export function Homebase(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ReviewSummary>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [repoFilter, setRepoFilter] = useState<RepoFilter>(null);
  /** Ids with an archive/unarchive request in flight, so the row can't be double-submitted. */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repoRes, reviewRes] = await Promise.all([
        callApi('listRepos'),
        // Unfiltered: the active/archived split and the repo filter are
        // client-side, so flipping either is instant rather than a round trip.
        callApi('listReviews'),
      ]);
      setRepos(repoRes.repos);
      setReviews(reviewRes.reviews);
      setSummaries(new Map(reviewRes.summaries.map((s) => [s.reviewId, s])));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Can't reach the review server: ${err.message}`
          : 'Unknown error loading Homebase',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = useCallback(async (review: Review, status: Review['status']) => {
    setPending((prev) => new Set(prev).add(review.id));
    try {
      const res = await callApi('setReviewStatus', { params: [review.id], body: { status } });
      // Reconcile against the authoritative row rather than assuming, so a
      // server-side correction shows up instead of being papered over.
      setReviews((prev) => prev.map((r) => (r.id === res.review.id ? res.review : r)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the review');
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(review.id);
        return next;
      });
    }
  }, []);

  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

  // Per-repo tallies for the rail: active count is what the rail shows, since
  // "3 things to look at in review-ui" is the question a dashboard answers.
  const activeByRepo = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reviews) {
      if (r.status === 'archived') continue;
      m.set(r.repoId, (m.get(r.repoId) ?? 0) + 1);
    }
    return m;
  }, [reviews]);

  const archivedCount = reviews.filter((r) => r.status === 'archived').length;
  const activeCount = reviews.length - archivedCount;

  // Most recently touched first: a dashboard's top row should be the thing
  // you were in the middle of, not the thing you opened first.
  const visible = useMemo(() => {
    const lastTouched = (r: Review): number => summaries.get(r.id)?.lastActivityAt ?? r.createdAt;
    return reviews
      .filter((r) => (tab === 'archived') === (r.status === 'archived'))
      .filter((r) => repoFilter === null || r.repoId === repoFilter)
      .sort((a, b) => lastTouched(b) - lastTouched(a));
  }, [reviews, summaries, tab, repoFilter]);

  const empty = !loading && error === null && visible.length === 0;
  const sortedRepos = useMemo(() => [...repos].sort((a, b) => repoName(a).localeCompare(repoName(b))), [repos]);

  return (
    <div className="flex h-full flex-col bg-chrome-bg-sunken p-2">
      <div className="mx-auto flex h-full w-full max-w-5xl min-h-0 flex-col gap-2">
        <TopBar title="Homebase">
          <button type="button" onClick={goExplore} className="chrome-btn bg-transparent">
            <Compass size={13} strokeWidth={1.75} aria-hidden />
            Explore
          </button>
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh"
            title="Refresh"
            className="chrome-icon-btn"
          >
            <RefreshCw size={15} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
          </button>
        </TopBar>

        {error !== null && (
          // Same treatment as the review window's divergence banner: an alert
          // is its own sibling in the shell column, never squeezed into an
          // island's header or list.
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-chrome-danger-bg px-3 py-2 text-xs font-medium text-chrome-fg"
          >
            <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0 text-chrome-danger" aria-hidden />
            <span>{error}</span>
            <span className="font-normal text-chrome-fg-muted">
              Start the server (<code>bun run dev:server</code>) and refresh.
            </span>
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-2">
          <aside className="chrome-island flex w-60 shrink-0 flex-col">
            <div className="flex h-10 shrink-0 items-center pl-4 pr-2">
              <h2 className="text-body font-medium text-chrome-fg">Repositories</h2>
            </div>
            <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-1">
              <li>
                <RailItem
                  icon={<Layers size={15} strokeWidth={1.5} aria-hidden />}
                  label="All repositories"
                  count={activeCount}
                  selected={repoFilter === null}
                  onSelect={() => setRepoFilter(null)}
                />
              </li>
              {sortedRepos.map((repo) => (
                <li key={repo.id}>
                  <RailItem
                    icon={<GitBranch size={15} strokeWidth={1.5} aria-hidden />}
                    label={repoName(repo)}
                    sublabel={repo.rootPath}
                    count={activeByRepo.get(repo.id) ?? 0}
                    selected={repoFilter === repo.id}
                    onSelect={() => setRepoFilter(repo.id)}
                  />
                </li>
              ))}
              {!loading && repos.length === 0 && (
                <li className="px-2.5 py-6 text-center text-xs leading-snug text-chrome-fg-muted">
                  No repositories registered yet.
                </li>
              )}
            </ul>
            <div className="shrink-0 px-2 pb-2 pt-3">
              <button type="button" onClick={goExplore} className="chrome-btn w-full justify-center">
                <Compass size={13} strokeWidth={1.75} aria-hidden />
                Browse branches and PRs
              </button>
            </div>
          </aside>

          <section className="chrome-island flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2">
              <h2 className="text-body font-medium text-chrome-fg">Reviews</h2>
              <div className="flex-1" />
              {/* Active/Archived as a segmented pair, the same control the threads
                  panel uses for Open/Resolved — one idiom for "which subset". */}
              <div role="tablist" aria-label="Review status" className="flex gap-1">
                <TabButton
                  label="Active"
                  count={activeCount}
                  selected={tab === 'active'}
                  onSelect={() => setTab('active')}
                />
                <TabButton
                  label="Archived"
                  count={archivedCount}
                  selected={tab === 'archived'}
                  onSelect={() => setTab('archived')}
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2 pt-1">
              {loading && reviews.length === 0 && (
                <p className="flex h-full items-center justify-center text-body text-chrome-fg-muted">Loading…</p>
              )}

              {empty && (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <GitBranch size={20} strokeWidth={1.5} className="text-chrome-fg-subtle" aria-hidden />
                  <p className="text-xs leading-snug text-chrome-fg-muted">
                    {tab === 'archived'
                      ? 'Nothing archived.'
                      : reviews.length === 0
                        ? 'No reviews yet. Open a branch or PR from Explore.'
                        : repoFilter !== null
                          ? 'No active reviews in this repository.'
                          : 'No active reviews — everything here is archived.'}
                  </p>
                  {tab === 'active' && (
                    <button type="button" onClick={goExplore} className="chrome-btn">
                      <Compass size={13} strokeWidth={1.5} aria-hidden />
                      Explore repositories
                    </button>
                  )}
                </div>
              )}

              <ul className="flex flex-col gap-0.5">
                {visible.map((review) => (
                  <ReviewRow
                    key={review.id}
                    review={review}
                    repo={repoById.get(review.repoId)}
                    showRepo={repoFilter === null}
                    summary={summaries.get(review.id) ?? { reviewId: review.id, ...EMPTY_SUMMARY }}
                    busy={pending.has(review.id)}
                    onOpen={() => goReview(review.id)}
                    onToggleArchived={() =>
                      void setStatus(review, review.status === 'archived' ? 'open' : 'archived')
                    }
                  />
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function RailItem({
  icon,
  label,
  sublabel,
  count,
  selected,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      title={sublabel}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        selected ? 'chrome-row-selected' : 'text-chrome-fg-muted hover:bg-chrome-bg-hover hover:text-chrome-fg'
      }`}
    >
      <span className="shrink-0 text-chrome-fg-subtle">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body">{label}</span>
        {sublabel !== undefined && (
          <span className="truncate text-micro text-chrome-fg-subtle">{sublabel}</span>
        )}
      </span>
      {count > 0 && (
        <span className="shrink-0 rounded-full bg-chrome-bg-hover px-1.5 text-micro tabular-nums text-chrome-fg-muted">
          {count}
        </span>
      )}
    </button>
  );
}

function TabButton({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
        selected ? 'bg-chrome-bg-active text-chrome-fg' : 'text-chrome-fg-muted hover:bg-chrome-bg-hover hover:text-chrome-fg'
      }`}
    >
      {label}
      {count > 0 && <span className="tabular-nums text-chrome-fg-subtle">{count}</span>}
    </button>
  );
}

function ReviewRow({
  review,
  repo,
  showRepo,
  summary,
  busy,
  onOpen,
  onToggleArchived,
}: {
  review: Review;
  repo: Repo | undefined;
  showRepo: boolean;
  summary: ReviewSummary;
  busy: boolean;
  onOpen: () => void;
  onToggleArchived: () => void;
}): React.JSX.Element {
  const archived = review.status === 'archived';
  const isPr = review.prNumber !== null;
  const Icon = isPr ? GitPullRequest : GitBranch;
  const touched = summary.lastActivityAt ?? review.createdAt;
  const hasReadingOrder = summary.readingOrderVersion !== null;

  const meta: string[] = [];
  if (showRepo && repo !== undefined) meta.push(repoName(repo));
  meta.push(`into ${review.baseRef}`);
  meta.push(summary.lastActivityAt === null ? `opened ${relativeTime(review.createdAt)}` : `active ${relativeTime(touched)}`);

  return (
    // Two sibling buttons rather than a button inside a button: the row body
    // opens the review, the trailing icon archives it. Hover paints the whole
    // row, so the two read as one control with a secondary action.
    <li className="group flex items-center rounded-md transition-colors hover:bg-chrome-bg-hover">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2.5 py-2 text-left"
      >
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-md ${
            isPr ? 'bg-chrome-accent-soft text-chrome-accent' : 'bg-chrome-bg-hover text-chrome-fg-muted'
          }`}
        >
          <Icon size={16} strokeWidth={1.5} aria-hidden />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-chrome-fg">
              {review.branch ?? review.pinnedSha?.slice(0, 10) ?? 'detached'}
            </span>
            {isPr && (
              <span className="shrink-0 rounded-[3px] bg-chrome-bg-hover px-1 text-micro tabular-nums text-chrome-fg-muted">
                #{review.prNumber}
              </span>
            )}
            {review.status === 'orphaned' && (
              <span
                className="shrink-0 rounded-[3px] bg-chrome-warning-bg px-1 text-micro text-chrome-warning"
                title="The branch this review tracked no longer exists"
              >
                orphaned
              </span>
            )}
            {summary.agentRunning && (
              <span className="flex shrink-0 items-center gap-1 text-micro text-chrome-accent" title="An agent run is in progress">
                <Loader2 size={11} strokeWidth={2} className="animate-spin" aria-hidden />
                agent working
              </span>
            )}
          </span>
          <span className="truncate text-micro text-chrome-fg-subtle">{meta.join(' · ')}</span>
        </span>

        {/* What's waiting on you (SPEC §1), as a fixed-width stat cluster so
            the columns line up row to row. Zero counts stay visible but
            subtle — an absent stat reads as "unknown", not "none". */}
        <span className="flex shrink-0 items-center gap-4 text-micro tabular-nums">
          <Stat
            icon={<MessageSquare size={13} strokeWidth={1.75} aria-hidden />}
            value={summary.openThreads}
            label={summary.openThreads === 1 ? 'open thread' : 'open threads'}
            emphasis={summary.openThreads > 0}
            title={`${String(summary.openThreads)} open, ${String(summary.resolvedThreads)} resolved`}
          />
          <Stat
            icon={<Check size={13} strokeWidth={1.75} aria-hidden />}
            value={summary.viewedFiles}
            label="viewed"
            title={`${String(summary.viewedFiles)} files marked viewed`}
          />
          <span
            className={`flex w-24 items-center gap-1 ${hasReadingOrder ? 'text-chrome-fg-muted' : 'text-chrome-fg-subtle'}`}
            title={
              hasReadingOrder
                ? `Reading order v${String(summary.readingOrderVersion)}`
                : 'No reading order generated yet'
            }
          >
            <ListOrdered size={13} strokeWidth={1.75} aria-hidden />
            {hasReadingOrder ? `order v${String(summary.readingOrderVersion)}` : 'no order'}
          </span>
        </span>
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onToggleArchived}
        aria-label={archived ? 'Unarchive review' : 'Archive review'}
        title={archived ? 'Unarchive' : 'Archive'}
        // Revealed on row hover or keyboard focus — an archive icon on every
        // row at rest is a column of identical glyphs that says nothing.
        className="chrome-icon-btn mr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
      >
        {archived ? (
          <ArchiveRestore size={15} strokeWidth={1.75} aria-hidden />
        ) : (
          <Archive size={15} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </li>
  );
}

function Stat({
  icon,
  value,
  label,
  emphasis = false,
  title,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  emphasis?: boolean;
  title: string;
}): React.JSX.Element {
  return (
    <span
      className={`flex w-24 items-center gap-1 ${
        emphasis ? 'text-chrome-fg' : value > 0 ? 'text-chrome-fg-muted' : 'text-chrome-fg-subtle'
      }`}
      title={title}
    >
      <span className={emphasis ? 'text-chrome-accent' : ''}>{icon}</span>
      {value} {label}
    </span>
  );
}
