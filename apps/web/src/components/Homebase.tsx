/**
 * Homebase — first pass at "an actual homebase", on real data.
 *
 * Two questions, two places: *what am I reviewing* (the page, centre) and
 * *what could I pick up next* (the queue, right). Both are ordered by an
 * effort score so the lightest thing is always at the top, and both wear
 * the same score glyph so the two columns read as one system.
 *
 * Behind the islands sits a backdrop — solid, a glow rising from the
 * bottom, or a painting — chosen from the corner switcher and remembered,
 * so the screen has a mood rather than a flat grey.
 *
 * Everything here comes from `useHomeData()`.
 */
import type { Pull, Repo, Review, ReviewSummary } from '@review/core';
import {
  Archive,
  Check,
  Compass,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { effortOf } from '../lib/effort.ts';
import { backdropProps, coverPainting, useBackdrop } from '../lib/covers.ts';
import { firstName, personFrom } from '../lib/people.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goExplore, goReview } from '../lib/router.ts';
import { useHomeData, type HomeReview } from '../state/HomeData.tsx';
import { BackdropPicker } from './home/BackdropPicker.tsx';
import { Avatar, Chip, CiIcon, CoverBand, DiffStat, EffortMeter, ProgressBar, SectionHeading, type Tone } from './home/primitives.tsx';
import { TopBar } from './TopBar.tsx';

type Order = 'effort' | 'recent';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const DATE = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' });

/** `remoteName` when known, else the last path segment of `rootPath`. */
function repoDisplayName(repo: Repo): string {
  if (repo.remoteName !== null) return repo.remoteName;
  const segments = repo.rootPath.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? repo.rootPath;
}

function reviewTitle(review: Review, summary: ReviewSummary): string {
  return summary.title ?? review.branch ?? (review.pinnedSha !== null ? review.pinnedSha.slice(0, 10) : 'detached');
}

function reviewLastActivityAt(hr: HomeReview): number {
  return hr.summary.lastActivityAt ?? hr.summary.headCommittedAt ?? hr.review.createdAt;
}

export function Homebase(): React.JSX.Element {
  const { repos, reviews, pullsByRepo, pullsAvailable, me, loading, refreshing, error, refresh, openPull, archiveReview, generateReadingOrder } =
    useHomeData();
  const [order, setOrder] = useState<Order>('effort');
  const [openingKeys, setOpeningKeys] = useState<ReadonlySet<string>>(new Set());
  const [backdrop, setBackdrop] = useBackdrop();
  const painting = coverPainting(backdrop);

  const youName = me?.name ?? me?.login ?? null;

  const reviewing = useMemo(() => reviews.filter((r) => r.bucket === 'attention'), [reviews]);
  const done = useMemo(() => reviews.filter((r) => r.bucket === 'done').sort((a, b) => reviewLastActivityAt(b) - reviewLastActivityAt(a)), [reviews]);

  const list = useMemo(() => {
    return [...reviewing].sort((a, b) =>
      order === 'effort' ? effortOf(a.summary).score - effortOf(b.summary).score : reviewLastActivityAt(b) - reviewLastActivityAt(a),
    );
  }, [order, reviewing]);

  // The queue: every open PR across every repo that has no review yet,
  // lightest first — so "I have twenty minutes" has an obvious answer.
  const queue = useMemo(
    () =>
      Array.from(pullsByRepo.entries())
        .flatMap(([repoId, pulls]) =>
          pulls
            .filter((p) => p.reviewId === null || p.reviewStatus === 'draft' || p.reviewStatus === 'archived')
            .map((p) => ({ repoId, pull: p })),
        )
        .sort(
          (a, b) =>
            effortOf({ filesTotal: a.pull.changedFiles, additions: a.pull.additions, deletions: a.pull.deletions }).score -
            effortOf({ filesTotal: b.pull.changedFiles, additions: b.pull.additions, deletions: b.pull.deletions }).score,
        ),
    [pullsByRepo],
  );

  const handleOpenPull = (repoId: string, pull: Pull) => {
    const key = `${repoId}:${String(pull.number)}`;
    setOpeningKeys((s) => new Set(s).add(key));
    void openPull(repoId, pull).finally(() => {
      setOpeningKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    });
  };

  const handleArchiveAll = () => {
    void (async () => {
      for (const r of done) {
        await archiveReview(r.review.id);
      }
    })();
  };

  const showSkeleton = loading && reviews.length === 0;
  const showNoRepos = !showSkeleton && repos.length === 0;
  const noPullsAvailable = repos.length > 0 && repos.every((r) => pullsAvailable.get(r.id) === false);

  return (
    <div className="home-shell flex h-full flex-col p-2" {...backdropProps(backdrop)}>
      <BackdropPicker value={backdrop} onChange={setBackdrop} />
      <div className="mx-auto flex h-full w-full max-w-6xl min-h-0 flex-col gap-2">
        <TopBar title="Homebase">
          <button type="button" onClick={goExplore} className="chrome-btn">
            <Compass size={13} strokeWidth={1.75} aria-hidden />
            Explore
          </button>
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void refresh({ force: true })}
            className="chrome-icon-btn"
          >
            <RefreshCw size={15} strokeWidth={1.75} className={refreshing || loading ? 'animate-spin' : ''} aria-hidden />
          </button>
        </TopBar>

        <div className="flex min-h-0 flex-1 gap-2">
          <main className="home-island min-w-0 flex-1 overflow-y-auto">
            {painting !== null && <CoverBand painting={painting} />}
            <div className={`mx-auto flex max-w-3xl flex-col gap-8 px-8 pb-10 ${painting !== null ? 'pt-4' : 'pt-10'}`}>
              <header className="flex flex-col gap-1">
                <p className="text-xs text-chrome-fg-subtle">{DATE.format(new Date())}</p>
                <h1 className="text-2xl font-semibold tracking-tight text-chrome-fg">
                  {greeting()}
                  {youName !== null ? `, ${youName}` : ''}
                </h1>
              </header>

              {error !== null && (
                <div className="flex items-center gap-2 text-xs text-chrome-danger">
                  <span>{error}</span>
                  <button type="button" onClick={() => void refresh({ force: true })} className="chrome-btn">
                    Retry
                  </button>
                </div>
              )}

              {showSkeleton ? (
                <SkeletonBlocks />
              ) : showNoRepos ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <p className="text-xs text-chrome-fg-muted">No repositories yet</p>
                  <button type="button" onClick={goExplore} className="chrome-btn">
                    Add one in Explore
                  </button>
                </div>
              ) : (
                <>
                  {(
                    <section className="flex flex-col gap-3">
                      <SectionHeading
                        title="Currently reviewing"
                        count={list.length}
                        action={
                          <div role="tablist" aria-label="Order" className="flex gap-1">
                            <OrderTab label="Lightest first" selected={order === 'effort'} onSelect={() => setOrder('effort')} />
                            <OrderTab label="Recent" selected={order === 'recent'} onSelect={() => setOrder('recent')} />
                          </div>
                        }
                      />
                      {reviewing.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">
                          Nothing in review — pick something up from the queue
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {list.map((r) => (
                            <ReviewCard key={r.review.id} review={r} you={youName} onGenerateReadingOrder={generateReadingOrder} />
                          ))}
                        </ul>
                      )}
                    </section>
                  )}

                  {(
                    <section className="flex flex-col gap-3">
                      <SectionHeading
                        title="Cleared"
                        count={done.length}
                        hint="all files viewed, nothing open"
                        action={
                          <button type="button" onClick={handleArchiveAll} className="chrome-btn bg-transparent">
                            <Archive size={13} strokeWidth={1.75} aria-hidden />
                            Archive all
                          </button>
                        }
                      />
                      <ul className="home-card divide-y divide-chrome-border hover:border-chrome-border hover:shadow-none">
                        {done.map((r) => (
                          <DoneRow key={r.review.id} review={r} onArchive={archiveReview} />
                        ))}
                      </ul>
                    </section>
                  )}

                </>
              )}
            </div>
          </main>

          <aside className="home-island flex w-80 shrink-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2">
              <h2 className="text-body font-medium text-chrome-fg">Up for review</h2>
              <span className="text-xs tabular-nums text-chrome-fg-subtle">{queue.length}</span>
            </div>
            {showSkeleton ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1 pb-2">
                <SkeletonBlocks height={92} />
              </div>
            ) : noPullsAvailable ? (
              <div className="px-2 pt-1 pb-2">
                <p className="rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">
                  Install and sign in to <code>gh</code> to see open pull requests here.
                </p>
              </div>
            ) : (
              <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-1 pb-2">
                {queue.map(({ repoId, pull }) => {
                  const key = `${repoId}:${String(pull.number)}`;
                  const repo = repos.find((r) => r.id === repoId);
                  return (
                    <QueueRow
                      key={key}
                      repoName={repo !== undefined ? repoDisplayName(repo) : repoId}
                      repoId={repoId}
                      pull={pull}
                      you={youName}
                      opening={openingKeys.has(key)}
                      onOpen={handleOpenPull}
                    />
                  );
                })}
              </ul>
            )}
            <div className="shrink-0 border-t border-chrome-border px-2 py-2">
              <button type="button" onClick={goExplore} className="chrome-btn w-full justify-center bg-transparent">
                <Compass size={13} strokeWidth={1.75} aria-hidden />
                Browse branches too
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function SkeletonBlocks({ height = 96 }: { height?: number }): React.JSX.Element {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="home-card animate-pulse" style={{ height }} />
      ))}
    </>
  );
}

function OrderTab({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex h-6 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
        selected ? 'bg-chrome-bg-active text-chrome-fg' : 'text-chrome-fg-muted hover:bg-chrome-bg-hover hover:text-chrome-fg'
      }`}
    >
      {label}
    </button>
  );
}

/** The "what's waiting in here" chips for a review card. CI, commits and steps are not chips: CI is the icon by the title, the rest is noise. */
function reasons(summary: ReviewSummary): { tone: Tone; icon: React.ReactNode; text: string }[] {
  const out: { tone: Tone; icon: React.ReactNode; text: string }[] = [];
  const i = { size: 11, strokeWidth: 2, 'aria-hidden': true } as const;
  if (summary.openThreads > 0)
    out.push({
      tone: 'neutral',
      icon: <MessageSquare {...i} />,
      text: `${String(summary.openThreads)} open ${summary.openThreads === 1 ? 'thread' : 'threads'}`,
    });
  return out;
}

function ReviewCard({
  review: hr,
  you,
  onGenerateReadingOrder,
}: {
  review: HomeReview;
  you: string | null;
  onGenerateReadingOrder: (id: string) => Promise<void>;
}): React.JSX.Element {
  const { review, summary, repo } = hr;
  const title = reviewTitle(review, summary);
  const author = personFrom(summary.authorName);
  const effort = effortOf(summary);
  const chips = reasons(summary);
  const showReadingOrderAction = summary.readingOrderVersion === null || summary.agentRunning;
  return (
    // The whole card opens the review via an underlay button, so the one
    // real control inside it (generate a reading order) isn't a button
    // nested in a button. Content ignores the pointer except that control.
    <li className="home-card group relative">
      <button type="button" onClick={() => goReview(review.id)} aria-label={`Open ${title}`} className="absolute inset-0 rounded-[inherit]" />
      <div className="pointer-events-none relative flex items-stretch gap-4 p-4">
        <Avatar person={author} size={32} />

        <span className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span className="flex flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-body font-medium text-chrome-fg">{title}</span>
              {review.status === 'orphaned' && <Chip>branch gone</Chip>}
              {review.prNumber !== null && (
                <span className="flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-chrome-fg-subtle">
                  <GitPullRequest size={11} strokeWidth={2} aria-hidden />
                  {review.prNumber}
                </span>
              )}
              {summary.draft && <Chip>draft</Chip>}
              <CiIcon ci={summary.ci} size={12} />
            </span>
            <span className="truncate text-micro text-chrome-fg-subtle">
              {repoDisplayName(repo)} · {review.baseRef} ← {review.branch ?? 'detached'} · {firstName(author, you)}
            </span>
          </span>

          {(chips.length > 0 || showReadingOrderAction) && (
            <span className="flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <Chip key={c.text} tone={c.tone} icon={c.icon}>
                  {c.text}
                </Chip>
              ))}
              {showReadingOrderAction &&
                (summary.agentRunning ? (
                  <button
                    type="button"
                    disabled
                    className="pointer-events-auto inline-flex h-5 items-center gap-1 rounded-md bg-chrome-accent-soft px-1.5 text-micro font-medium whitespace-nowrap text-chrome-accent"
                  >
                    <Loader2 size={11} strokeWidth={2} className="animate-spin" aria-hidden />
                    Generating…
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onGenerateReadingOrder(review.id)}
                    className="pointer-events-auto inline-flex h-5 items-center gap-1 rounded-md bg-chrome-accent-soft px-1.5 text-micro font-medium whitespace-nowrap text-chrome-accent transition-[filter] hover:brightness-110"
                  >
                    <Sparkles size={11} strokeWidth={2} aria-hidden />
                    Generate reading order
                  </button>
                ))}
            </span>
          )}
        </span>

        {/* Right column, three aligned lines: diff size, progress, effort · files viewed. */}
        <span className="flex w-48 shrink-0 flex-col justify-between gap-1.5 text-micro">
          <span className="flex justify-end">
            {summary.filesTotal === null ? (
              <span className="text-chrome-fg-subtle">—</span>
            ) : (
              <DiffStat additions={summary.additions ?? 0} deletions={summary.deletions ?? 0} />
            )}
          </span>
          {summary.filesTotal !== null && <ProgressBar value={summary.viewedFiles} total={summary.filesTotal} />}
          <span className="flex items-end justify-between leading-none">
            <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
            <span className="tabular-nums whitespace-nowrap text-chrome-fg-subtle">
              <span className="font-medium text-chrome-fg-muted">{summary.viewedFiles}</span> of {summary.filesTotal ?? '—'} files
            </span>
          </span>
        </span>
      </div>
    </li>
  );
}

function DoneRow({ review: hr, onArchive }: { review: HomeReview; onArchive: (id: string) => Promise<void> }): React.JSX.Element {
  const { review, summary, repo } = hr;
  const title = reviewTitle(review, summary);
  const author = personFrom(summary.authorName);
  return (
    <li className="group flex items-center transition-colors hover:bg-chrome-bg-hover">
      <button type="button" onClick={() => goReview(review.id)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-chrome-success-bg text-chrome-success">
          <Check size={14} strokeWidth={2.25} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body text-chrome-fg-muted group-hover:text-chrome-fg">{title}</span>
            {review.prNumber !== null && <span className="shrink-0 text-micro tabular-nums text-chrome-fg-subtle">#{review.prNumber}</span>}
          </span>
          <span className="truncate text-micro text-chrome-fg-subtle">
            {repoDisplayName(repo)} · {summary.resolvedThreads} resolved · {summary.filesTotal ?? summary.viewedFiles} files viewed ·{' '}
            {relativeTime(summary.lastActivityAt ?? summary.headCommittedAt ?? review.createdAt)}
          </span>
        </span>
        <Avatar person={author} size={20} />
      </button>
      <button
        type="button"
        aria-label="Archive review"
        title="Archive"
        onClick={(e) => {
          e.stopPropagation();
          void onArchive(review.id);
        }}
        className="chrome-icon-btn mr-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Archive size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

function QueueRow({
  repoId,
  repoName,
  pull: p,
  you,
  opening,
  onOpen,
}: {
  repoId: string;
  repoName: string;
  pull: Pull;
  you: string | null;
  opening: boolean;
  onOpen: (repoId: string, pull: Pull) => void;
}): React.JSX.Element {
  const effort = effortOf({ filesTotal: p.changedFiles, additions: p.additions, deletions: p.deletions });
  const author = personFrom(p.authorLogin);
  const flags: React.ReactNode[] = [];
  if (p.isDraft) flags.push(<Chip key="draft">draft</Chip>);
  if (p.reviewRequested) flags.push(<Chip key="req" tone="warning">review requested</Chip>);
  if (p.reviewStatus === 'draft') flags.push(<Chip key="opened">opened</Chip>);
  if (p.reviewStatus === 'archived') flags.push(<Chip key="archived">archived</Chip>);
  return (
    <li>
      {/* Three fixed columns — avatar, text, effort — so every row lines
          up: title on the first line, facts on the second, flags (if any)
          on a third. Nothing floats to the right except the effort. */}
      <button
        type="button"
        disabled={opening}
        aria-busy={opening}
        onClick={() => onOpen(repoId, p)}
        className="group flex w-full items-start gap-3 rounded-md px-3 py-3.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:opacity-60"
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="line-clamp-2 text-body font-medium leading-snug text-chrome-fg">{p.title}</span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <CiIcon ci={p.ci} size={11} />
            <span className="truncate">
              {repoName} #{p.number} · {firstName(author, you)}
            </span>
          </span>
          {flags.length > 0 && <span className="flex items-center gap-1">{flags}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(p.updatedAtUnix)}</span>
        </span>
      </button>
    </li>
  );
}
