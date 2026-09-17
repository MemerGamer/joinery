/**
 * Explore — first pass on mock data.
 *
 * A finder, nothing more: one search field, the repositories as pills, then
 * two plain lists to scroll — pull requests and branches, local and remote.
 * Anything you already have a review of is left out; that lives on
 * Homebase. Rows use the same shape as Homebase's queue so the two screens
 * rhyme without Explore growing a personality of its own.
 *
 * Everything here comes from `mock/homebase.ts`; nothing is wired.
 */
import { Cloud, FolderGit2, GitBranch, HardDrive, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { backdropProps, coverPainting, useBackdrop } from '../lib/covers.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goHomebase } from '../lib/router.ts';
import { BRANCHES, PULLS, REPOS, YOU, effortOf, type MockBranch, type MockPull } from '../mock/homebase.ts';
import { BackdropPicker } from './home/BackdropPicker.tsx';
import { Avatar, Chip, CiIcon, CoverBand, EffortMeter, Kbd, SectionHeading } from './home/primitives.tsx';
import { TopBar } from './TopBar.tsx';

function firstName(p: { name: string }): string {
  return p.name === YOU.name ? 'you' : (p.name.split(' ')[0] ?? p.name);
}

export function Explore(): React.JSX.Element {
  const [repoId, setRepoId] = useState<string>(REPOS[0]?.id ?? '');
  const [q, setQ] = useState('');
  const [backdrop, setBackdrop] = useBackdrop();
  const painting = coverPainting(backdrop);
  const needle = q.trim().toLowerCase();
  const repo = REPOS.find((r) => r.id === repoId);

  const pulls = useMemo(
    () =>
      (PULLS[repoId] ?? [])
        .filter((p) => p.reviewId === null)
        .filter(
          (p) =>
            needle === '' ||
            p.title.toLowerCase().includes(needle) ||
            p.headRefName.toLowerCase().includes(needle) ||
            `#${String(p.number)}`.includes(needle),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [repoId, needle],
  );

  const branches = useMemo(() => {
    const heads = new Set((PULLS[repoId] ?? []).map((p) => p.headRefName));
    return (BRANCHES[repoId] ?? [])
      .filter((b) => !heads.has(b.name) && b.reviewId === null)
      .filter((b) => needle === '' || b.name.toLowerCase().includes(needle) || b.subject.toLowerCase().includes(needle))
      .sort((a, b) => b.committerDate - a.committerDate);
  }, [repoId, needle]);

  const countFor = (id: string): number => (PULLS[id]?.length ?? 0) + (BRANCHES[id]?.length ?? 0);

  return (
    <div className="home-shell flex h-full flex-col p-2" {...backdropProps(backdrop)}>
      <BackdropPicker value={backdrop} onChange={setBackdrop} />
      <div className="mx-auto flex h-full w-full max-w-6xl min-h-0 flex-col gap-2">
        <TopBar title="Explore" onBack={goHomebase} />

        <main className="home-island flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {painting !== null && <CoverBand painting={painting} height={160} />}
            <div className={`mx-auto flex max-w-4xl flex-col gap-7 px-8 pb-8 ${painting !== null ? 'pt-3' : 'pt-8'}`}>
              <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold tracking-tight text-chrome-fg">Open something</h1>
                <p className="text-body text-chrome-fg-muted">
                  Any branch or pull request in your registered repositories. Opening the same thing twice lands on the same review.
                </p>
              </header>

              {/* The search field is the hero of this page: big, borderless
                  inside, one focus ring. Everything below filters as you type. */}
              <label className="home-card flex h-11 items-center gap-3 px-3.5 focus-within:border-chrome-accent focus-within:shadow-chrome">
                <Search size={16} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && q !== '') setQ('');
                  }}
                  placeholder={`Search ${repo?.name ?? 'this repo'} — a branch, a PR title, or #number`}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Search branches and pull requests"
                  className="h-full min-w-0 flex-1 bg-transparent text-body text-chrome-fg outline-hidden! placeholder:text-chrome-fg-subtle"
                />
                <span className="flex items-center gap-1 text-micro text-chrome-fg-subtle">
                  <Kbd>↵</Kbd> open
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-1.5">
                {REPOS.map((r) => {
                  const selected = r.id === repoId;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRepoId(r.id)}
                      aria-pressed={selected}
                      title={r.rootPath}
                      className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors ${
                        selected
                          ? 'bg-chrome-fg text-chrome-bg'
                          : 'bg-chrome-bg-hover text-chrome-fg-muted hover:bg-chrome-bg-active hover:text-chrome-fg'
                      }`}
                    >
                      <FolderGit2 size={13} strokeWidth={1.75} aria-hidden />
                      {r.name}
                      <span className={`tabular-nums ${selected ? 'opacity-60' : 'text-chrome-fg-subtle'}`}>{countFor(r.id)}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-chrome-border-strong px-3 text-xs font-medium text-chrome-fg-muted transition-colors hover:border-chrome-fg-subtle hover:text-chrome-fg"
                >
                  <Plus size={13} strokeWidth={1.75} aria-hidden />
                  Add repository
                </button>
              </div>

              <section className="flex flex-col gap-2">
                <SectionHeading title="Pull requests" count={pulls.length} hint="open, not yet reviewed" />
                {pulls.length === 0 ? (
                  <Empty>{needle === '' ? 'Nothing open that you aren\'t already reviewing.' : `No pull requests match "${q.trim()}".`}</Empty>
                ) : (
                  <ul className="-mx-2.5 flex flex-col">
                    {pulls.map((p) => (
                      <PullRow key={p.number} pull={p} />
                    ))}
                  </ul>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <SectionHeading title="Branches" count={branches.length} hint="local and remote, newest first" />
                {branches.length === 0 ? (
                  <Empty>{needle === '' ? 'No branches.' : `No branches match "${q.trim()}".`}</Empty>
                ) : (
                  <ul className="-mx-2.5 flex flex-col">
                    {branches.map((b) => (
                      <BranchRow key={b.name} branch={b} defaultBranch={repo?.defaultBranch ?? 'main'} />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>

          <div className="flex h-8 shrink-0 items-center gap-3 border-t border-chrome-border px-3.5 text-micro text-chrome-fg-subtle">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> clear
            </span>
            <div className="flex-1" />
            {repo !== undefined && <span>50 most recent branches — type to search the rest</span>}
          </div>
        </main>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg border border-dashed border-chrome-border px-4 py-6 text-center text-xs text-chrome-fg-muted">{children}</p>
  );
}

function PullRow({ pull: p }: { pull: MockPull }): React.JSX.Element {
  const effort = effortOf(p);
  return (
    <li>
      <button type="button" className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover">
        <Avatar person={p.author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-chrome-fg">{p.title}</span>
            {p.draft && <Chip>draft</Chip>}
            {p.reviewRequested && <Chip tone="warning">review requested</Chip>}
          </span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <CiIcon ci={p.ci} size={11} />
            <span className="truncate">
              #{p.number} · {p.headRefName} → {p.baseRefName} · {firstName(p.author)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(p.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

function BranchRow({ branch: b, defaultBranch }: { branch: MockBranch; defaultBranch: string }): React.JSX.Element {
  const isDefault = b.name === defaultBranch;
  return (
    <li>
      <button type="button" className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover">
        <Avatar person={b.author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs font-medium text-chrome-fg">{b.name}</span>
            {isDefault && <Chip>default</Chip>}
          </span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <GitBranch size={11} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="truncate">
              {b.subject} · {firstName(b.author)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span className="flex items-center gap-1 text-micro text-chrome-fg-muted" title={b.local && b.remote ? 'Local and on origin' : b.local ? 'Local only' : 'Only on origin'}>
            {b.local && <HardDrive size={11} strokeWidth={2} aria-label="local" />}
            {b.remote && <Cloud size={11} strokeWidth={2} aria-label="origin" />}
            {!isDefault && (b.ahead > 0 || b.behind > 0) && (
              <span className="tabular-nums">
                ↑{b.ahead} ↓{b.behind}
              </span>
            )}
          </span>
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(b.committerDate)}</span>
        </span>
      </button>
    </li>
  );
}
