/**
 * Homebase — first pass at "an actual homebase", on real data.
 *
 * Two questions, two places: *what am I reviewing* (the page, centre) and
 * *what could I pick up next* (the queue, right). Both are ordered by an
 * effort score so the lightest thing is always at the top, and both wear
 * the same score glyph so the two columns read as one system.
 *
 * Behind the panels sits a backdrop — solid, a glow rising from the
 * bottom, or a painting — chosen from the corner switcher and remembered,
 * so the screen has a mood rather than a flat grey. A painting (or a
 * glow, painted as a small landscape by `GlowScene`) fills a
 * full-width hero band that dissolves into the page; the greeting sits
 * centred on its lower edge, the two columns below it, and Explore — the
 * finder over every branch and pull request — below those, a scroll away.
 *
 * Everything here comes from `useHomeData()`.
 */
import type { Pull, Repo, Review, ReviewSummary } from '@review/core';
import {
  Archive,
  Check,
  Clock,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RefreshCw,
  Waypoints,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { effortOf } from '../lib/effort.ts';
import { backdropProps, coverGlow, coverPainting, paintingUrl, useBackdrop } from '../lib/covers.ts';
import { firstName, personFrom } from '../lib/people.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goExplore, goReview } from '../lib/router.ts';
import { useHomeData, type HomeReview } from '../state/HomeData.tsx';
import { BackdropPicker } from './home/BackdropPicker.tsx';
import { GlowScene } from './home/GlowScene.tsx';
import { Panel } from './home/Panel.tsx';
import { Avatar, Chip, CiIcon, DiffStat, EffortMeter, ProgressBar, type Tone } from './home/primitives.tsx';
import { ExploreSection } from './Explore.tsx';

type Order = 'effort' | 'recent';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const HERO_HEIGHT = 'clamp(220px, 50vh, 500px)';
/** Space above Explore: this much normally, shrinking toward the minimum so its header still peeks in when the panels end on screen. */
const EXPLORE_GAP_MAX = 72;
const EXPLORE_GAP_MIN = 24;
/** How much of Explore must show at the fold to read as "more below": its header and a sliver of body. */
const EXPLORE_PEEK = 48;
const HERO_MASK = 'linear-gradient(to bottom, black 0%, black 55%, transparent 100%)';
/** Glows the text in the page colour so it reads over the painting. */
const GLOW_BG = '0 0 18px var(--chrome-bg-sunken), 0 0 6px var(--chrome-bg-sunken)';

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const [exploreGap, setExploreGap] = useState(EXPLORE_GAP_MAX);

  // When the panels end inside the first screen, pull Explore up just enough
  // that its header shows at the fold — a cue that the page scrolls. Past
  // the fold there's nothing to do: cut-off cards already say so.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const top = topRef.current;
    if (scroller === null || top === null) return;
    const measure = () => {
      const topBottom = top.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
      if (topBottom >= scroller.clientHeight) {
        setExploreGap(EXPLORE_GAP_MAX);
        return;
      }
      const room = scroller.clientHeight - topBottom - EXPLORE_PEEK;
      setExploreGap(Math.min(EXPLORE_GAP_MAX, Math.max(EXPLORE_GAP_MIN, room)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(top);
    return () => ro.disconnect();
  }, []);
  const painting = coverPainting(backdrop);
  const glow = coverGlow(backdrop);
  const hasHero = painting !== null || glow !== null;

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
  const topPad = hasHero ? `calc(${HERO_HEIGHT} - 84px)` : '2.5rem';
  const noPullsAvailable = repos.length > 0 && repos.every((r) => pullsAvailable.get(r.id) === false);
  const showQueue = showSkeleton || noPullsAvailable || queue.length > 0;

  return (
    <div className="home-shell h-full" {...backdropProps(backdrop)}>
      <BackdropPicker value={backdrop} onChange={setBackdrop} />
      <button
        type="button"
        aria-label="Refresh"
        title="Refresh"
        onClick={() => void refresh({ force: true })}
        className="chrome-icon-btn absolute top-4 right-4 z-20 bg-chrome-bg/70 backdrop-blur"
      >
        <RefreshCw size={15} strokeWidth={1.75} className={refreshing || loading ? 'animate-spin' : ''} aria-hidden />
      </button>
      <div ref={scrollRef} className="relative h-full overflow-y-auto">
        {/* Hero band: the painting (or a glow's painted scene) dissolves into the page over its lower ~45%. */}
        {hasHero && (
          <div className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden" style={{ height: HERO_HEIGHT }} aria-hidden>
            {painting !== null ? (
              <img
                src={paintingUrl(painting, 'full')}
                alt=""
                className="absolute inset-0 size-full object-cover"
                style={{ objectPosition: '50% 35%', maskImage: HERO_MASK, WebkitMaskImage: HERO_MASK }}
              />
            ) : (
              glow !== null && <GlowScene glow={glow} mask={HERO_MASK} />
            )}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(to bottom, transparent 0%, transparent 40%, color-mix(in srgb, var(--chrome-bg-sunken) 55%, transparent) 75%, var(--chrome-bg-sunken) 100%)',
              }}
            />
            {/* Dither: a fine dot grid over the painting, for a pixel-art feel. */}
            <div
              className="absolute inset-0 opacity-30 mix-blend-multiply"
              style={{ backgroundImage: 'radial-gradient(rgba(0,0,0,0.55) 0.8px, transparent 1px)', backgroundSize: '4px 4px' }}
            />
            {/* Public domain, but still someone's work. */}
            {painting !== null && (
              <span className="absolute top-4 left-4 rounded-md bg-chrome-bg/70 px-1.5 py-0.5 text-micro text-chrome-fg-muted backdrop-blur">
                {painting.name} · {painting.artist}
              </span>
            )}
          </div>
        )}

        <div
          className="relative mx-auto flex max-w-6xl flex-col gap-6 px-2 pb-10"
          style={{ paddingTop: topPad }}
        >
          <div ref={topRef} className="flex flex-col gap-6">
            {/* mb-6 on top of the gap lets the panels start just past the hero's edge, not on it. */}
            <header className="mb-6 flex flex-col items-center gap-1">
              <p className="text-xs text-chrome-fg-muted" style={{ textShadow: GLOW_BG }}>
                {DATE.format(new Date())}
              </p>
              <h1 className="text-center text-2xl font-semibold tracking-tight text-chrome-fg" style={{ textShadow: GLOW_BG }}>
                {greeting()}
                {youName !== null ? `, ${youName}` : ''}
              </h1>
            </header>

            {error !== null && (
              <div className="flex items-center justify-center gap-2 text-xs text-chrome-danger">
                <span>{error}</span>
                <button type="button" onClick={() => void refresh({ force: true })} className="chrome-btn">
                  Retry
                </button>
              </div>
            )}

            {/* Both columns share one height: the row's, set by the reviews (with a floor); the queue scrolls inside it. */}
            {/* Without the queue pane the cards would stretch across the whole column, so the row narrows to roughly the width they have beside it; Explore keeps the full width. */}
            <div className={`flex min-h-72 w-full items-stretch gap-3 ${showQueue ? '' : 'mx-auto max-w-4xl'}`}>
              <main className="flex min-w-0 flex-1 flex-col gap-3">
                {showSkeleton ? (
                  <div className="flex flex-col gap-2">
                    <SkeletonBlocks />
                  </div>
                ) : showNoRepos ? (
                  <Panel title="Currently reviewing" className="flex-1">
                    <div className="flex flex-col items-center gap-3 py-16 text-center">
                      <p className="text-xs text-chrome-fg-muted">No repositories yet</p>
                      <button type="button" onClick={goExplore} className="chrome-btn">
                        Add one in Explore
                      </button>
                    </div>
                  </Panel>
                ) : (
                  <>
                    <Panel
                      icon={<GitPullRequest aria-hidden />}
                      title="Currently reviewing"
                      count={list.length}
                      className="flex-1"
                      bodyClassName="px-2 pb-2"
                      actions={
                        // Ordering one (or no) review changes nothing, so the tabs only show when there's something to reorder.
                        list.length > 1 ? (
                          <div role="tablist" aria-label="Order" className="flex gap-1">
                            <OrderTab label="Lightest first" selected={order === 'effort'} onSelect={() => setOrder('effort')} />
                            <OrderTab label="Recent" selected={order === 'recent'} onSelect={() => setOrder('recent')} />
                          </div>
                        ) : undefined
                      }
                    >
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
                    </Panel>

                    {done.length > 0 && (
                      <Panel
                        icon={<Check aria-hidden />}
                        title={
                          <>
                            Cleared <span className="font-normal text-chrome-fg-subtle">· all files viewed, nothing open</span>
                          </>
                        }
                        count={done.length}
                        bodyClassName="px-0 pb-0"
                        actions={
                          <button type="button" onClick={handleArchiveAll} className="chrome-btn bg-transparent">
                            <Archive size={13} strokeWidth={1.75} aria-hidden />
                            Archive all
                          </button>
                        }
                      >
                        <ul className="divide-y divide-chrome-border border-t border-chrome-border">
                          {done.map((r) => (
                            <DoneRow key={r.review.id} review={r} onArchive={archiveReview} />
                          ))}
                        </ul>
                      </Panel>
                    )}
                  </>
                )}
              </main>

              {/* No queue, no pane: Currently reviewing takes the full width. The gh hint still shows. */}
              {showQueue && (
                // The absolute box takes the row's height without adding to it, so a long queue scrolls instead of stretching the row.
                <div className="relative w-96 shrink-0">
                  <Panel
                    icon={<Clock aria-hidden />}
                    title="Up for review"
                    count={queue.length}
                    className="absolute! inset-0"
                    bodyClassName="flex flex-col px-0 pb-0"
                  >
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
                  </Panel>
                </div>
              )}
            </div>
          </div>

          {!showSkeleton && (
            // A chapter break, not just a gap: what's in hand above, everything else below.
            // The column's own gap-6 (24px) counts toward the space above.
            <div style={{ paddingTop: exploreGap - EXPLORE_GAP_MIN }}>
              <ExploreSection />
            </div>
          )}
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
                  <span
                    role="status"
                    className="inline-flex h-5 items-center gap-1 rounded-md bg-chrome-accent-soft px-1.5 text-micro font-medium whitespace-nowrap text-chrome-accent"
                  >
                    <Loader2 size={11} strokeWidth={2} className="animate-spin" aria-hidden />
                    Generating reading order…
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onGenerateReadingOrder(review.id)}
                    // Grey until hovered: it repeats on most cards, so in accent it would shout.
                    className="pointer-events-auto inline-flex h-5 items-center gap-1 rounded-md bg-chrome-bg-hover px-1.5 text-micro font-medium whitespace-nowrap text-chrome-fg-muted! transition-colors hover:bg-chrome-accent-soft hover:text-chrome-accent!"
                  >
                    <Waypoints size={11} strokeWidth={2} aria-hidden />
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
