/**
 * Homebase — first pass at "an actual homebase", on mock data.
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
 * Every number here comes from `mock/homebase.ts`; nothing is wired.
 */
import {
  Archive,
  Check,
  Compass,
  GitPullRequest,
  Inbox,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { backdropProps, coverPainting, useBackdrop } from '../lib/covers.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goExplore, goReview } from '../lib/router.ts';
import { PULLS, REPOS, REVIEWS, YOU, effortOf, type MockPull, type MockReview } from '../mock/homebase.ts';
import { BackdropPicker } from './home/BackdropPicker.tsx';
import { Avatar, Chip, CiIcon, CoverBand, DiffStat, EffortMeter, Kbd, ProgressBar, SectionHeading, type Tone } from './home/primitives.tsx';
import { TopBar } from './TopBar.tsx';

type Focus = 'reviewing' | 'replies' | 'done' | null;
type Order = 'effort' | 'recent';

const repoById = new Map(REPOS.map((r) => [r.id, r]));

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const DATE = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' });

function firstName(p: { name: string }): string {
  return p.name === YOU.name ? 'you' : (p.name.split(' ')[0] ?? p.name);
}

export function Homebase(): React.JSX.Element {
  const [focus, setFocus] = useState<Focus>(null);
  const [order, setOrder] = useState<Order>('effort');
  const [backdrop, setBackdrop] = useBackdrop();
  const painting = coverPainting(backdrop);

  const reviewing = useMemo(() => REVIEWS.filter((r) => r.bucket === 'attention'), []);
  const done = useMemo(() => REVIEWS.filter((r) => r.bucket === 'done').sort((a, b) => b.lastActivityAt - a.lastActivityAt), []);
  const unread = reviewing.reduce((n, r) => n + r.unreadReplies, 0);
  const withReplies = reviewing.filter((r) => r.unreadReplies > 0);

  const list = useMemo(() => {
    const base = focus === 'replies' ? withReplies : reviewing;
    return [...base].sort((a, b) =>
      order === 'effort' ? effortOf(a).score - effortOf(b).score : b.lastActivityAt - a.lastActivityAt,
    );
  }, [focus, order, reviewing, withReplies]);

  // The queue: every open PR across every repo that has no review yet,
  // lightest first — so "I have twenty minutes" has an obvious answer.
  const queue = useMemo(
    () =>
      Object.entries(PULLS)
        .flatMap(([repoId, pulls]) => pulls.filter((p) => p.reviewId === null).map((p) => ({ repoId, pull: p })))
        .sort((a, b) => effortOf(a.pull).score - effortOf(b.pull).score),
    [],
  );

  const toggle = (f: Exclude<Focus, null>) => () => setFocus((cur) => (cur === f ? null : f));

  return (
    <div className="home-shell flex h-full flex-col p-2" {...backdropProps(backdrop)}>
      <BackdropPicker value={backdrop} onChange={setBackdrop} />
      <div className="mx-auto flex h-full w-full max-w-6xl min-h-0 flex-col gap-2">
        <TopBar title="Homebase">
          <button type="button" className="chrome-btn bg-transparent text-chrome-fg-subtle">
            <Search size={13} strokeWidth={1.75} aria-hidden />
            Jump to…
            <Kbd>⌘K</Kbd>
          </button>
          <button type="button" onClick={goExplore} className="chrome-btn">
            <Compass size={13} strokeWidth={1.75} aria-hidden />
            Explore
          </button>
          <button type="button" aria-label="Refresh" title="Refresh" className="chrome-icon-btn">
            <RefreshCw size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </TopBar>

        <div className="flex min-h-0 flex-1 gap-2">
          <main className="home-island min-w-0 flex-1 overflow-y-auto">
            {painting !== null && <CoverBand painting={painting} />}
            <div className={`mx-auto flex max-w-3xl flex-col gap-8 px-8 pb-10 ${painting !== null ? 'pt-4' : 'pt-10'}`}>
              <header className="flex flex-col gap-1">
                <p className="text-xs text-chrome-fg-subtle">{DATE.format(new Date())}</p>
                <h1 className="text-2xl font-semibold tracking-tight text-chrome-fg">
                  {greeting()}, {YOU.name}
                </h1>
              </header>

              {/* One strip of numbers, each a filter. Said once, here — the
                  cards below carry the detail, so no prose restating them. */}
              <div className="flex items-stretch divide-x divide-chrome-border rounded-lg border border-chrome-border">
                <Stat
                  value={reviewing.length}
                  label="reviewing"
                  icon={<Inbox size={14} strokeWidth={1.75} aria-hidden />}
                  active={focus === 'reviewing'}
                  onClick={toggle('reviewing')}
                />
                <Stat
                  value={unread}
                  label="agent replies"
                  icon={<Sparkles size={14} strokeWidth={1.75} aria-hidden />}
                  active={focus === 'replies'}
                  onClick={toggle('replies')}
                />
                <Stat
                  value={done.length}
                  label="cleared"
                  icon={<Check size={14} strokeWidth={1.75} aria-hidden />}
                  active={focus === 'done'}
                  onClick={toggle('done')}
                />
                <Stat
                  value={queue.length}
                  label="up for review"
                  icon={<GitPullRequest size={14} strokeWidth={1.75} aria-hidden />}
                />
              </div>

              {focus !== 'done' && (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    title={focus === 'replies' ? 'Agent replies to read' : 'Currently reviewing'}
                    count={list.length}
                    action={
                      <div role="tablist" aria-label="Order" className="flex gap-1">
                        <OrderTab label="Lightest first" selected={order === 'effort'} onSelect={() => setOrder('effort')} />
                        <OrderTab label="Recent" selected={order === 'recent'} onSelect={() => setOrder('recent')} />
                      </div>
                    }
                  />
                  <ul className="flex flex-col gap-2">
                    {list.map((r) => (
                      <ReviewCard key={r.id} review={r} />
                    ))}
                  </ul>
                </section>
              )}

              {(focus === null || focus === 'done') && (
                <section className="flex flex-col gap-3">
                  <SectionHeading
                    title="Cleared"
                    count={done.length}
                    hint="all files viewed, nothing open"
                    action={
                      <button type="button" className="chrome-btn bg-transparent">
                        <Archive size={13} strokeWidth={1.75} aria-hidden />
                        Archive all
                      </button>
                    }
                  />
                  <ul className="home-card divide-y divide-chrome-border hover:border-chrome-border hover:shadow-none">
                    {done.map((r) => (
                      <DoneRow key={r.id} review={r} />
                    ))}
                  </ul>
                </section>
              )}

              {focus !== null && (
                <button type="button" onClick={() => setFocus(null)} className="self-start text-xs text-chrome-accent hover:underline">
                  Show everything
                </button>
              )}
            </div>
          </main>

          <aside className="home-island flex w-80 shrink-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2">
              <h2 className="text-body font-medium text-chrome-fg">Up for review</h2>
              <span className="text-xs tabular-nums text-chrome-fg-subtle">{queue.length}</span>
            </div>
            <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-1 pb-2">
              {queue.map(({ repoId, pull }) => (
                <QueueRow key={`${repoId}:${String(pull.number)}`} repoName={repoById.get(repoId)?.name ?? repoId} pull={pull} />
              ))}
            </ul>
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

function Stat({
  value,
  label,
  icon,
  active = false,
  onClick,
}: {
  value: number;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const body = (
    <span className="flex items-center gap-1.5 text-xs text-chrome-fg-muted">
      <span className={active ? 'text-chrome-accent' : 'text-chrome-fg-subtle'}>{icon}</span>
      <span className="text-xl font-semibold leading-none tracking-tight tabular-nums text-chrome-fg">{value}</span>
      {label}
    </span>
  );
  const cls = `flex min-w-0 flex-1 items-center px-4 py-3 text-left transition-colors ${active ? 'bg-chrome-accent-soft/50' : ''}`;
  if (onClick === undefined) return <div className={cls}>{body}</div>;
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${cls} hover:bg-chrome-bg-hover`}>
      {body}
    </button>
  );
}

/** The "what's waiting in here" chips for a review card. CI, commits and steps are not chips: CI is the icon by the title, the rest is noise. */
function reasons(r: MockReview): { tone: Tone; icon: React.ReactNode; text: string }[] {
  const out: { tone: Tone; icon: React.ReactNode; text: string }[] = [];
  const i = { size: 11, strokeWidth: 2, 'aria-hidden': true } as const;
  if (r.openThreads > 0)
    out.push({ tone: 'neutral', icon: <MessageSquare {...i} />, text: `${String(r.openThreads)} open ${r.openThreads === 1 ? 'thread' : 'threads'}` });
  return out;
}

function ReviewCard({ review: r }: { review: MockReview }): React.JSX.Element {
  const repo = repoById.get(r.repoId);
  const effort = effortOf(r);
  const chips = reasons(r);
  return (
    // The whole card opens the review via an underlay button, so the one
    // real control inside it (generate a reading order) isn't a button
    // nested in a button. Content ignores the pointer except that control.
    <li className="home-card group relative">
      <button type="button" onClick={() => goReview(r.id)} aria-label={`Open ${r.title}`} className="absolute inset-0 rounded-[inherit]" />
      <div className="pointer-events-none relative flex items-stretch gap-4 p-4">
        <Avatar person={r.author} size={32} />

        <span className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span className="flex flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-body font-medium text-chrome-fg">{r.title}</span>
              {r.prNumber !== null && (
                <span className="flex shrink-0 items-center gap-0.5 text-micro tabular-nums text-chrome-fg-subtle">
                  <GitPullRequest size={11} strokeWidth={2} aria-hidden />
                  {r.prNumber}
                </span>
              )}
              {r.draft && <Chip>draft</Chip>}
              <CiIcon ci={r.ci} size={12} />
            </span>
            <span className="truncate text-micro text-chrome-fg-subtle">
              {repo?.name} · {r.baseRef} ← {r.branch} · {firstName(r.author)}
            </span>
          </span>

          {(chips.length > 0 || r.readingOrder === null) && (
            <span className="flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <Chip key={c.text} tone={c.tone} icon={c.icon}>
                  {c.text}
                </Chip>
              ))}
              {r.readingOrder === null && (
                <button
                  type="button"
                  className="pointer-events-auto inline-flex h-5 items-center gap-1 rounded-md bg-chrome-accent-soft px-1.5 text-micro font-medium whitespace-nowrap text-chrome-accent transition-[filter] hover:brightness-110"
                >
                  <Sparkles size={11} strokeWidth={2} aria-hidden />
                  Generate reading order
                </button>
              )}
            </span>
          )}
        </span>

        {/* Right column, three aligned lines: diff size, progress, effort · files viewed. */}
        <span className="flex w-48 shrink-0 flex-col justify-between gap-1.5 text-micro">
          <span className="flex justify-end">
            <DiffStat additions={r.additions} deletions={r.deletions} />
          </span>
          <ProgressBar value={r.filesViewed} total={r.filesTotal} />
          <span className="flex items-end justify-between leading-none">
            <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
            <span className="tabular-nums whitespace-nowrap text-chrome-fg-subtle">
              <span className="font-medium text-chrome-fg-muted">{r.filesViewed}</span> of {r.filesTotal} files
            </span>
          </span>
        </span>
      </div>
    </li>
  );
}

function DoneRow({ review: r }: { review: MockReview }): React.JSX.Element {
  const repo = repoById.get(r.repoId);
  return (
    <li className="group flex items-center transition-colors hover:bg-chrome-bg-hover">
      <button type="button" onClick={() => goReview(r.id)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-chrome-success-bg text-chrome-success">
          <Check size={14} strokeWidth={2.25} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body text-chrome-fg-muted group-hover:text-chrome-fg">{r.title}</span>
            {r.prNumber !== null && <span className="shrink-0 text-micro tabular-nums text-chrome-fg-subtle">#{r.prNumber}</span>}
          </span>
          <span className="truncate text-micro text-chrome-fg-subtle">
            {repo?.name} · {r.resolvedThreads} resolved · {r.filesTotal} files viewed · {relativeTime(r.lastActivityAt)}
          </span>
        </span>
        <Avatar person={r.author} size={20} />
      </button>
      <button
        type="button"
        aria-label="Archive review"
        title="Archive"
        className="chrome-icon-btn mr-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Archive size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

function QueueRow({ repoName, pull: p }: { repoName: string; pull: MockPull }): React.JSX.Element {
  const effort = effortOf(p);
  const flags: React.ReactNode[] = [];
  if (p.draft) flags.push(<Chip key="draft">draft</Chip>);
  if (p.reviewRequested) flags.push(<Chip key="req" tone="warning">review requested</Chip>);
  return (
    <li>
      {/* Three fixed columns — avatar, text, effort — so every row lines
          up: title on the first line, facts on the second, flags (if any)
          on a third. Nothing floats to the right except the effort. */}
      <button type="button" className="group flex w-full items-start gap-3 rounded-md px-3 py-3.5 text-left transition-colors hover:bg-chrome-bg-hover">
        <Avatar person={p.author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="line-clamp-2 text-body font-medium leading-snug text-chrome-fg">{p.title}</span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <CiIcon ci={p.ci} size={11} />
            <span className="truncate">
              {repoName} #{p.number} · {firstName(p.author)}
            </span>
          </span>
          {flags.length > 0 && <span className="flex items-center gap-1">{flags}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(p.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}
