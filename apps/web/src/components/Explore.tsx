/**
 * Explore — a finder over real repositories.
 *
 * One search field, the repositories as pills, then two plain lists to
 * scroll — pull requests and branches, local and remote. Anything you
 * already have a review of is left out; that lives on Homebase. Rows use
 * the same shape as Homebase's queue so the two screens rhyme without
 * Explore growing a personality of its own.
 *
 * Data comes from `useHomeData()` (repos, open pulls) plus a direct,
 * debounced `listBranches` call per repo/query — branches aren't part of
 * the shared snapshot since there can be thousands of them per repo.
 */
import { Cloud, FolderGit2, GitBranch, HardDrive, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Branch, Pull, Repo, ReviewStatus } from '@review/core';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { backdropProps, coverPainting, useBackdrop } from '../lib/covers.ts';
import { effortOf } from '../lib/effort.ts';
import { firstName, personFrom, type Person } from '../lib/people.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goHomebase } from '../lib/router.ts';
import { useHomeData } from '../state/HomeData.tsx';
import { BackdropPicker } from './home/BackdropPicker.tsx';
import { Avatar, Chip, CiIcon, CoverBand, EffortMeter, Kbd, SectionHeading } from './home/primitives.tsx';
import { TopBar } from './TopBar.tsx';

const REPO_STORAGE_KEY = 'review-ui:explore:repo';
const BRANCH_DEBOUNCE_MS = 200;
const BRANCH_LIMIT = 50;

type Row = { kind: 'pull'; pull: Pull } | { kind: 'branch'; branch: Branch };

function pullKey(n: number): string {
  return `pull-${String(n)}`;
}
function branchKey(name: string): string {
  return `branch-${name}`;
}
function rowKeyOf(row: Row): string {
  return row.kind === 'pull' ? pullKey(row.pull.number) : branchKey(row.branch.name);
}

/** A pull/branch is claimed — and hidden from Explore — when its review is `open` or `orphaned`. */
function isClaimed(status: ReviewStatus | null): boolean {
  return status === 'open' || status === 'orphaned';
}

function repoLabel(r: Repo): string {
  if (r.remoteName !== null) return r.remoteName;
  const trimmed = r.rootPath.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || r.rootPath;
}

/** Reads/writes `sessionStorage` defensively — it throws in some privacy contexts. */
function readStoredRepoId(): string | null {
  try {
    return sessionStorage.getItem(REPO_STORAGE_KEY);
  } catch {
    return null;
  }
}
function persistRepoId(id: string): void {
  try {
    sessionStorage.setItem(REPO_STORAGE_KEY, id);
  } catch {
    // Best-effort only.
  }
}

export function Explore(): React.JSX.Element {
  const { repos, pullsByRepo, pullsAvailable, me, loading, error, openPull, openBranch, addRepo } = useHomeData();
  const you = me?.name ?? me?.login ?? null;

  const [repoId, setRepoIdState] = useState<string>(() => readStoredRepoId() ?? '');
  const [q, setQ] = useState('');
  const [backdrop, setBackdrop] = useBackdrop();
  const painting = coverPainting(backdrop);
  const needle = q.trim().toLowerCase();

  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const [addingRepo, setAddingRepo] = useState(false);
  const [repoPath, setRepoPath] = useState('');
  const [addRepoBusy, setAddRepoBusy] = useState(false);
  const [addRepoError, setAddRepoError] = useState<{ message: string; hint?: string | undefined } | null>(null);

  const [branchesRaw, setBranchesRaw] = useState<Branch[]>([]);
  const branchReqIdRef = useRef(0);
  const branchAbortRef = useRef<AbortController | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const repoPathInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const noRepos = !loading && repos.length === 0;

  // Fall back to the first repo when nothing (or a stale id) is stored.
  useEffect(() => {
    if (repos.length === 0) return;
    setRepoIdState((prev) => (repos.some((r) => r.id === prev) ? prev : (repos[0]?.id ?? prev)));
  }, [repos]);

  useEffect(() => {
    if (repoId !== '') persistRepoId(repoId);
  }, [repoId]);

  useEffect(() => {
    if (!loading && repos.length === 0) setAddingRepo(true);
  }, [loading, repos.length]);

  const repo = repos.find((r) => r.id === repoId);

  const pulls = useMemo(() => {
    const list = (pullsByRepo.get(repoId) ?? []).filter((p) => !isClaimed(p.reviewStatus));
    const filtered =
      needle === ''
        ? list
        : list.filter(
            (p) =>
              p.title.toLowerCase().includes(needle) ||
              p.headRefName.toLowerCase().includes(needle) ||
              `#${String(p.number)}`.includes(needle),
          );
    return filtered.slice().sort((a, b) => b.updatedAtUnix - a.updatedAtUnix);
  }, [pullsByRepo, repoId, needle]);

  // Debounced, abortable branch fetch. Stale responses are dropped via a
  // request counter as well as the abort, in case a server races past it.
  useEffect(() => {
    if (repoId === '') {
      setBranchesRaw([]);
      return;
    }
    const timer = setTimeout(() => {
      branchAbortRef.current?.abort();
      const controller = new AbortController();
      branchAbortRef.current = controller;
      const reqId = ++branchReqIdRef.current;
      void (async () => {
        try {
          const res = await callApi('listBranches', {
            params: [repoId],
            query: { limit: BRANCH_LIMIT, ...(needle !== '' ? { filter: needle } : {}) },
            signal: controller.signal,
          });
          if (reqId !== branchReqIdRef.current) return;
          setBranchesRaw(res.branches);
        } catch (err) {
          if (reqId !== branchReqIdRef.current) return;
          if (err instanceof ApiError) setOpenError(err.message);
        }
      })();
    }, BRANCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [repoId, needle]);

  useEffect(() => () => branchAbortRef.current?.abort(), []);

  const branches = useMemo(() => {
    const heads = new Set((pullsByRepo.get(repoId) ?? []).filter((p) => !isClaimed(p.reviewStatus)).map((p) => p.headRefName));
    return branchesRaw.filter((b) => !heads.has(b.name) && !isClaimed(b.reviewStatus));
  }, [branchesRaw, pullsByRepo, repoId]);

  const rows = useMemo<Row[]>(
    () => [...pulls.map((pull): Row => ({ kind: 'pull', pull })), ...branches.map((branch): Row => ({ kind: 'branch', branch }))],
    [pulls, branches],
  );

  // Reset the highlight whenever the query or the selected repo changes.
  useEffect(() => {
    setHighlighted(null);
  }, [needle, repoId]);

  useEffect(() => {
    if (highlighted === null) return;
    const row = rows[highlighted];
    if (row === undefined) return;
    rowRefs.current.get(rowKeyOf(row))?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, rows]);

  function setRowRef(key: string, el: HTMLLIElement | null): void {
    if (el === null) rowRefs.current.delete(key);
    else rowRefs.current.set(key, el);
  }

  async function openRow(row: Row): Promise<void> {
    const key = rowKeyOf(row);
    setBusyKey(key);
    setOpenError(null);
    try {
      if (row.kind === 'pull') {
        await openPull(repoId, row.pull);
      } else {
        await openBranch(repoId, row.branch);
      }
    } catch (err) {
      setOpenError(err instanceof ApiError ? err.message : 'Failed to open.');
    } finally {
      setBusyKey(null);
    }
  }

  function handleNavKey(e: { key: string; preventDefault: () => void }): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return;
      e.preventDefault();
      setHighlighted((prev) => {
        if (prev === null) return e.key === 'ArrowDown' ? 0 : rows.length - 1;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        return (prev + delta + rows.length) % rows.length;
      });
    } else if (e.key === 'Enter') {
      const idx = highlighted ?? (needle !== '' ? 0 : null);
      if (idx === null) return;
      const row = rows[idx];
      if (row === undefined) return;
      e.preventDefault();
      void openRow(row);
    } else if (e.key === 'Escape') {
      if (q !== '') setQ('');
    }
  }

  const handleNavKeyRef = useRef(handleNavKey);
  handleNavKeyRef.current = handleNavKey;

  // A single listener on the island's DOM node catches bubbled keydowns from
  // anywhere inside it — the search field, but also a row button once it has
  // focus after a click — so arrow-key navigation keeps working either way.
  // The search field's own `onKeyDown` (below) already handles its keys, so
  // it's excluded here to avoid double-processing.
  useEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    const listener = (e: KeyboardEvent): void => {
      if (e.target === searchInputRef.current) return;
      handleNavKeyRef.current(e);
    };
    main.addEventListener('keydown', listener);
    return () => main.removeEventListener('keydown', listener);
  }, []);

  function countFor(id: string): number {
    const unreviewedPulls = (pullsByRepo.get(id) ?? []).filter((p) => !isClaimed(p.reviewStatus)).length;
    return id === repoId ? unreviewedPulls + branches.length : unreviewedPulls;
  }

  async function submitAddRepo(): Promise<void> {
    const path = repoPath.trim();
    if (path === '') return;
    setAddRepoBusy(true);
    setAddRepoError(null);
    try {
      const created = await addRepo(path);
      setRepoIdState(created.id);
      setAddingRepo(false);
      setRepoPath('');
    } catch (err) {
      if (err instanceof ApiError) setAddRepoError({ message: err.message, hint: err.hint });
      else setAddRepoError({ message: 'Failed to add repository.' });
    } finally {
      setAddRepoBusy(false);
    }
  }

  const formOpen = addingRepo || noRepos;
  const displayError = openError ?? error;

  return (
    <div className="home-shell flex h-full flex-col p-2" {...backdropProps(backdrop)}>
      <BackdropPicker value={backdrop} onChange={setBackdrop} />
      <div className="mx-auto flex h-full w-full max-w-6xl min-h-0 flex-col gap-2">
        <TopBar title="Explore" onBack={goHomebase} />

        <main ref={mainRef} className="home-island flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {painting !== null && <CoverBand painting={painting} height={160} />}
            <div className={`mx-auto flex max-w-4xl flex-col gap-7 px-8 pb-8 ${painting !== null ? 'pt-3' : 'pt-8'}`}>
              <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold tracking-tight text-chrome-fg">Open something</h1>
                <p className="text-body text-chrome-fg-muted">
                  Any branch or pull request in your registered repositories. Opening the same thing twice lands on the same review.
                </p>
              </header>

              {!noRepos && (
                <>
                  {/* The search field is the hero of this page: big, borderless
                      inside, one focus ring. Everything below filters as you type. */}
                  <label className="home-card flex h-11 items-center gap-3 px-3.5 focus-within:border-chrome-accent focus-within:shadow-chrome">
                    <Search size={16} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                    <input
                      ref={searchInputRef}
                      autoFocus
                      disabled={loading}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      onKeyDown={handleNavKey}
                      placeholder={`Search ${repo !== undefined ? repoLabel(repo) : 'this repo'} — a branch, a PR title, or #number`}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Search branches and pull requests"
                      className="h-full min-w-0 flex-1 bg-transparent text-body text-chrome-fg outline-hidden! placeholder:text-chrome-fg-subtle disabled:opacity-60"
                    />
                    <span className="flex items-center gap-1 text-micro text-chrome-fg-subtle">
                      <Kbd>↵</Kbd> open
                    </span>
                  </label>
                  {displayError !== null && <p className="text-xs text-chrome-danger">{displayError}</p>}
                </>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                {repos.map((r) => {
                  const selected = r.id === repoId;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRepoIdState(r.id)}
                      aria-pressed={selected}
                      title={r.rootPath}
                      // Text colours carry `!`: the unlayered global `button { color: inherit }`
                      // in styles/index.css otherwise beats layered Tailwind utilities.
                      className={`flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                        selected
                          ? 'border-chrome-accent bg-chrome-accent-soft text-chrome-accent!'
                          : 'border-transparent bg-chrome-bg-hover text-chrome-fg-muted! hover:bg-chrome-bg-active hover:text-chrome-fg!'
                      }`}
                    >
                      <FolderGit2 size={13} strokeWidth={1.75} aria-hidden />
                      {repoLabel(r)}
                      <span className={`tabular-nums ${selected ? 'opacity-70' : 'text-chrome-fg-subtle'}`}>{countFor(r.id)}</span>
                    </button>
                  );
                })}
                {formOpen ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitAddRepo();
                    }}
                    className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-chrome-border-strong pr-1 pl-3"
                  >
                    <input
                      ref={repoPathInputRef}
                      type="text"
                      autoFocus
                      value={repoPath}
                      disabled={addRepoBusy}
                      onChange={(e) => setRepoPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          if (!noRepos) {
                            setAddingRepo(false);
                            setRepoPath('');
                            setAddRepoError(null);
                          }
                        } else if (e.key === 'Enter') {
                          e.stopPropagation();
                        }
                      }}
                      placeholder="Absolute path to a git clone"
                      spellCheck={false}
                      autoComplete="off"
                      className="h-5 w-56 bg-transparent font-mono text-xs text-chrome-fg outline-hidden! placeholder:text-chrome-fg-subtle"
                    />
                    <button type="submit" disabled={addRepoBusy || repoPath.trim() === ''} className="chrome-btn h-5 px-2 text-xs">
                      Add
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingRepo(true)}
                    className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-chrome-border-strong px-3 text-xs font-medium text-chrome-fg-muted! transition-colors hover:border-chrome-fg-subtle hover:text-chrome-fg!"
                  >
                    <Plus size={13} strokeWidth={1.75} aria-hidden />
                    Add repository
                  </button>
                )}
              </div>
              {addRepoError !== null && (
                <p className="text-micro text-chrome-danger">
                  {addRepoError.message}
                  {addRepoError.hint !== undefined ? ` — ${addRepoError.hint}` : ''}
                </p>
              )}

              {noRepos ? (
                <Empty>Register a repository to start.</Empty>
              ) : (
                <>
                  <section className="flex flex-col gap-2">
                    <SectionHeading title="Pull requests" count={pulls.length} hint="open, not started" />
                    {loading ? (
                      <Empty>Loading…</Empty>
                    ) : pullsAvailable.get(repoId) === false ? (
                      <Empty>Install and sign in to `gh` to list pull requests.</Empty>
                    ) : pulls.length === 0 ? (
                      <Empty>{needle === '' ? "Nothing open that you aren't already reviewing." : `No pull requests match "${q.trim()}".`}</Empty>
                    ) : (
                      <ul role="listbox" aria-label="Pull requests" className="-mx-2.5 flex flex-col">
                        {pulls.map((p) => {
                          const key = pullKey(p.number);
                          const idx = rows.findIndex((r) => r.kind === 'pull' && r.pull.number === p.number);
                          return (
                            <PullRow
                              key={p.number}
                              pull={p}
                              you={you}
                              highlighted={idx === highlighted}
                              busy={busyKey === key}
                              registerRef={(el) => setRowRef(key, el)}
                              onOpen={() => void openRow({ kind: 'pull', pull: p })}
                            />
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="flex flex-col gap-2">
                    <SectionHeading title="Branches" count={branches.length} hint="local and remote, newest first" />
                    {loading ? (
                      <Empty>Loading…</Empty>
                    ) : branches.length === 0 ? (
                      <Empty>{needle === '' ? 'No branches.' : `No branches match "${q.trim()}".`}</Empty>
                    ) : (
                      <ul role="listbox" aria-label="Branches" className="-mx-2.5 flex flex-col">
                        {branches.map((b) => {
                          const key = branchKey(b.name);
                          const idx = rows.findIndex((r) => r.kind === 'branch' && r.branch.name === b.name);
                          return (
                            <BranchRow
                              key={b.name}
                              branch={b}
                              you={you}
                              isDefault={b.name === repo?.defaultBranch}
                              highlighted={idx === highlighted}
                              busy={busyKey === key}
                              registerRef={(el) => setRowRef(key, el)}
                              onOpen={() => void openRow({ kind: 'branch', branch: b })}
                            />
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </>
              )}
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
            {repo !== undefined && (
              <span>
                {branchesRaw.length === BRANCH_LIMIT
                  ? `${String(BRANCH_LIMIT)} most recent branches — type to search the rest`
                  : `${String(branches.length)} ${branches.length === 1 ? 'branch' : 'branches'}`}
              </span>
            )}
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

function PullRow({
  pull: p,
  you,
  highlighted,
  busy,
  registerRef,
  onOpen,
}: {
  pull: Pull;
  you: string | null;
  highlighted: boolean;
  busy: boolean;
  registerRef: (el: HTMLLIElement | null) => void;
  onOpen: () => void;
}): React.JSX.Element {
  const author: Person = personFrom(p.authorLogin);
  const effort = effortOf({ filesTotal: p.changedFiles, additions: p.additions, deletions: p.deletions });
  return (
    <li ref={registerRef} role="option" aria-selected={highlighted}>
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        onClick={onOpen}
        className={`group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:cursor-wait ${highlighted ? 'bg-chrome-bg-hover' : ''}`}
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-chrome-fg">{p.title}</span>
            {p.isDraft && <Chip>draft</Chip>}
            {p.reviewRequested && <Chip tone="warning">review requested</Chip>}
            {p.reviewStatus === 'draft' && <Chip>opened</Chip>}
            {p.reviewStatus === 'archived' && <Chip>archived</Chip>}
          </span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <CiIcon ci={p.ci} size={11} />
            <span className="truncate">
              #{p.number} · {p.headRefName} → {p.baseRefName} · {firstName(author, you)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <EffortMeter level={effort.level} label={effort.label} minutes={effort.minutes} />
          <span className="text-micro tabular-nums text-chrome-fg-subtle">{relativeTime(p.updatedAtUnix)}</span>
        </span>
      </button>
    </li>
  );
}

function BranchRow({
  branch: b,
  you,
  isDefault,
  highlighted,
  busy,
  registerRef,
  onOpen,
}: {
  branch: Branch;
  you: string | null;
  isDefault: boolean;
  highlighted: boolean;
  busy: boolean;
  registerRef: (el: HTMLLIElement | null) => void;
  onOpen: () => void;
}): React.JSX.Element {
  const author: Person = personFrom(b.authorName);
  return (
    <li ref={registerRef} role="option" aria-selected={highlighted}>
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        onClick={onOpen}
        className={`group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-chrome-bg-hover disabled:cursor-wait ${highlighted ? 'bg-chrome-bg-hover' : ''}`}
      >
        <Avatar person={author} size={24} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs font-medium text-chrome-fg">{b.name}</span>
            {isDefault && <Chip>default</Chip>}
            {b.reviewStatus === 'draft' && <Chip>opened</Chip>}
            {b.reviewStatus === 'archived' && <Chip>archived</Chip>}
          </span>
          <span className="flex items-center gap-1.5 text-micro text-chrome-fg-subtle">
            <GitBranch size={11} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="truncate">
              {b.subject ?? ''} · {firstName(author, you)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span
            className="flex items-center gap-1 text-micro text-chrome-fg-muted"
            title={b.hasLocalRef && b.hasRemoteRef ? 'Local and on origin' : b.hasLocalRef ? 'Local only' : 'Only on origin'}
          >
            {b.hasLocalRef && <HardDrive size={11} strokeWidth={2} aria-label="local" />}
            {b.hasRemoteRef && <Cloud size={11} strokeWidth={2} aria-label="origin" />}
            {!isDefault && b.ahead !== null && b.behind !== null && (b.ahead > 0 || b.behind > 0) && (
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
