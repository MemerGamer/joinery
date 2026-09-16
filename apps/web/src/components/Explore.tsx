/**
 * Explore (SPEC §4, "open any branch or PR"): pick a repo, type, hit Enter.
 *
 * One interaction to learn. PRs and branches share a single filtered list
 * rather than living behind tabs, because the question being asked is "what
 * do I want to look at", not "which kind of thing is it". Rows that already
 * have a review are marked, so this doubles as "where did I leave off".
 *
 * Opening a row is create-or-find, never create-blindly: the server dedupes
 * on `(repo, branch)`, and a PR resolves to its own head branch, so opening
 * the same thing twice lands on the same review.
 *
 * Same shell and column width as Homebase: top bar island, then the repo
 * rail and the list side by side on the shell's 8px gap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { ApiError, callApi } from '../lib/apiClient.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { goHomebase, goReview } from '../lib/router.ts';
import { TopBar } from './TopBar.tsx';
import type { Branch, Pull, Repo, Review } from '@review/core';

/** A branch and a PR collapse to the same row shape so one list can render both. */
type Row =
  | { kind: 'pull'; key: string; when: number; pull: Pull }
  | { kind: 'branch'; key: string; when: number; branch: Branch };

/**
 * How many branches the server is asked for when the filter is empty. The
 * list says so when it hits this, because "the 50 newest" is not "all".
 */
const BRANCH_LIMIT = 50;

function repoName(repo: Repo): string {
  return repo.rootPath.split('/').filter(Boolean).at(-1) ?? repo.rootPath;
}

export function Explore(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [ghAvailable, setGhAvailable] = useState(true);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [filter, setFilter] = useState('');
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [loadingPulls, setLoadingPulls] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [newRepoPath, setNewRepoPath] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const [repoRes, reviewRes] = await Promise.all([callApi('listRepos'), callApi('listReviews')]);
      setRepos(repoRes.repos);
      setReviews(reviewRes.reviews);
      // Keep the selection if it still exists; otherwise fall to the first
      // repo (or none), so a repo removed under us can't leave a dead id
      // selected with an empty list and no explanation.
      setRepoId((current) =>
        current !== null && repoRes.repos.some((r) => r.id === current) ? current : (repoRes.repos[0]?.id ?? null),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `Can't reach the review server: ${err.message}` : 'Unknown error');
    } finally {
      setLoadingRepos(false);
    }
  }, []);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  // PRs are fetched once per repo, not per keystroke: `gh pr list` is a
  // round trip to GitHub, and the client filters the (small) result itself.
  useEffect(() => {
    if (repoId === null) return;
    const controller = new AbortController();
    setLoadingPulls(true);
    void (async () => {
      try {
        const res = await callApi('listPulls', { params: [repoId], signal: controller.signal });
        setPulls(res.pulls);
        setGhAvailable(res.available);
      } catch (err) {
        if (controller.signal.aborted) return;
        // Branches still work without PRs, so this is a note, not the error banner.
        setPulls([]);
        setGhAvailable(!(err instanceof ApiError));
      } finally {
        if (!controller.signal.aborted) setLoadingPulls(false);
      }
    })();
    return () => controller.abort();
  }, [repoId]);

  // Branches are filtered server-side (a monorepo's ref namespace is far too
  // large to ship whole), so this query re-runs as you type — debounced, and
  // aborted when superseded so a slow response can't overwrite a newer one.
  useEffect(() => {
    if (repoId === null) return;
    const controller = new AbortController();
    const needle = filter.trim();
    const timer = setTimeout(() => {
      setLoadingBranches(true);
      void (async () => {
        try {
          const res = await callApi('listBranches', {
            params: [repoId],
            query: needle === '' ? { limit: BRANCH_LIMIT } : { filter: needle, limit: BRANCH_LIMIT },
            signal: controller.signal,
          });
          setBranches(res.branches);
          setError(null);
        } catch (err) {
          if (controller.signal.aborted) return;
          setError(err instanceof ApiError ? err.message : 'Could not list branches');
        } finally {
          if (!controller.signal.aborted) setLoadingBranches(false);
        }
      })();
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [repoId, filter]);

  // A review exists for a branch when the row's branch name matches — which is
  // also how a PR is identified (`(repo, headRefName)`), so one lookup covers
  // both kinds of row.
  const reviewByBranch = useMemo(() => {
    const map = new Map<string, Review>();
    for (const r of reviews) {
      if (r.repoId === repoId && r.branch !== null) map.set(r.branch, r);
    }
    return map;
  }, [reviews, repoId]);

  const rows = useMemo<Row[]>(() => {
    const needle = filter.trim().toLowerCase();
    const pullRows: Row[] = pulls
      .filter(
        (p) =>
          needle === '' ||
          p.title.toLowerCase().includes(needle) ||
          p.headRefName.toLowerCase().includes(needle) ||
          `#${String(p.number)}`.includes(needle),
      )
      .map((p) => ({
        kind: 'pull' as const,
        key: `pull:${String(p.number)}`,
        when: Math.floor(new Date(p.updatedAt).getTime() / 1000),
        pull: p,
      }));

    // A branch that is already listed as a PR's head would be a duplicate row
    // for the same review — the PR row wins, since it carries strictly more
    // context (number, title, base).
    const pullHeads = new Set(pulls.map((p) => p.headRefName));
    const branchRows: Row[] = branches
      .filter((b) => !pullHeads.has(b.name))
      .map((b) => ({ kind: 'branch' as const, key: `branch:${b.name}`, when: b.committerDate, branch: b }));

    return [...pullRows, ...branchRows].sort((a, b) => b.when - a.when);
  }, [pulls, branches, filter]);

  useEffect(() => {
    setActiveIndex(0);
  }, [rows.length, repoId]);

  // Arrow-key selection has to stay visible in a scrolling list; mouse
  // selection is already where the pointer is, so `nearest` is a no-op there.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${String(activeIndex)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const open = useCallback(
    async (row: Row) => {
      if (repoId === null || opening !== null) return;
      setOpening(row.key);
      try {
        const res = await callApi('createReview', {
          body:
            row.kind === 'pull'
              ? { repoId, prNumber: row.pull.number }
              : { repoId, branch: row.branch.name },
        });
        goReview(res.review.id);
      } catch (err) {
        setError(err instanceof ApiError ? (err.hint ?? err.message) : 'Could not open that');
        setOpening(null);
      }
    },
    [repoId, opening],
  );

  const addRepo = useCallback(async () => {
    const path = newRepoPath.trim();
    if (path === '' || addingRepo) return;
    setAddingRepo(true);
    try {
      const res = await callApi('addRepo', { body: { path } });
      setNewRepoPath('');
      setRepoId(res.repo.id);
      setError(null);
      await loadRepos();
      filterRef.current?.focus();
    } catch (err) {
      // The server's messages here are specific ("not a git repository: ...",
      // "path must be absolute") — surface them verbatim rather than a generic
      // failure, since they tell you exactly what to type instead.
      setError(err instanceof ApiError ? [err.message, err.hint].filter(Boolean).join(' — ') : 'Could not add repo');
    } finally {
      setAddingRepo(false);
    }
  }, [newRepoPath, addingRepo, loadRepos]);

  const loadingList = loadingBranches || loadingPulls;
  const truncated = filter.trim() === '' && branches.length >= BRANCH_LIMIT;
  const selectedRepo = repos.find((r) => r.id === repoId);
  const pullCount = rows.filter((r) => r.kind === 'pull').length;
  const branchCount = rows.length - pullCount;
  const sortedRepos = useMemo(() => [...repos].sort((a, b) => repoName(a).localeCompare(repoName(b))), [repos]);

  return (
    <div className="flex h-full flex-col bg-chrome-bg-sunken p-2">
      <div className="mx-auto flex h-full w-full max-w-5xl min-h-0 flex-col gap-2">
        <TopBar title="Explore" onBack={goHomebase}>
          <button
            type="button"
            onClick={() => void loadRepos()}
            aria-label="Refresh"
            title="Refresh"
            className="chrome-icon-btn"
          >
            <RefreshCw size={15} strokeWidth={1.75} className={loadingRepos ? 'animate-spin' : ''} aria-hidden />
          </button>
        </TopBar>

        {error !== null && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-chrome-danger-bg px-3 py-2 text-xs font-medium text-chrome-fg"
          >
            <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0 text-chrome-danger" aria-hidden />
            {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-2">
          <aside className="chrome-island flex w-60 shrink-0 flex-col">
            <div className="flex h-10 shrink-0 items-center pl-4 pr-2">
              <h2 className="text-body font-medium text-chrome-fg">Repositories</h2>
            </div>
            <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-1">
              {sortedRepos.map((repo) => {
                const selected = repo.id === repoId;
                return (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => setRepoId(repo.id)}
                      title={repo.rootPath}
                      aria-current={selected}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                        selected ? 'chrome-row-selected' : 'text-chrome-fg-muted hover:bg-chrome-bg-hover hover:text-chrome-fg'
                      }`}
                    >
                      <GitBranch size={15} strokeWidth={1.5} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body">{repoName(repo)}</span>
                        <span className="truncate text-micro text-chrome-fg-subtle">{repo.rootPath}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {!loadingRepos && repos.length === 0 && (
                <li className="px-2.5 py-6 text-center text-xs leading-snug text-chrome-fg-muted">
                  No repositories yet. Add one below.
                </li>
              )}
            </ul>

            <form
              className="flex shrink-0 flex-col gap-1.5 px-2 pb-2 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void addRepo();
              }}
            >
              <label htmlFor="add-repo" className="px-0.5 text-xs font-medium text-chrome-fg-muted">
                Add a repository
              </label>
              <div className="flex items-center gap-1">
                <input
                  id="add-repo"
                  value={newRepoPath}
                  onChange={(e) => setNewRepoPath(e.target.value)}
                  placeholder="/absolute/path/to/clone"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7 min-w-0 flex-1 rounded-md bg-chrome-bg-hover px-2 text-xs text-chrome-fg outline-none placeholder:text-chrome-fg-subtle focus:bg-chrome-bg-active"
                />
                <button
                  type="submit"
                  disabled={addingRepo || newRepoPath.trim() === ''}
                  aria-label="Add repository"
                  title="Add repository"
                  className="chrome-icon-btn disabled:opacity-40"
                >
                  {addingRepo ? (
                    <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden />
                  ) : (
                    <FolderPlus size={15} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
              </div>
            </form>
          </aside>

          <section className="chrome-island flex min-w-0 flex-1 flex-col">
            {/* The filter *is* the pane header: a borderless input in the
                header slot, the way the command palette's search sits in its
                top row — not a boxed field floating above the list. */}
            <div className="flex h-10 shrink-0 items-center gap-2 pl-4 pr-3">
              <Search size={15} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
              <input
                ref={filterRef}
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const row = rows[activeIndex];
                    if (row !== undefined) void open(row);
                  } else if (e.key === 'Escape' && filter !== '') {
                    e.preventDefault();
                    setFilter('');
                  }
                }}
                placeholder={
                  repoId === null
                    ? 'Add a repository first'
                    : `Filter branches and pull requests in ${selectedRepo === undefined ? 'this repo' : repoName(selectedRepo)}…`
                }
                disabled={repoId === null}
                spellCheck={false}
                autoComplete="off"
                aria-label="Filter branches and pull requests"
                className="h-full min-w-0 flex-1 bg-transparent text-body text-chrome-fg outline-hidden! placeholder:text-chrome-fg-subtle disabled:opacity-50"
              />
              {loadingList ? (
                <Loader2 size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-chrome-fg-subtle" aria-hidden />
              ) : (
                rows.length > 0 && (
                  <span className="shrink-0 text-micro tabular-nums text-chrome-fg-subtle">
                    {pullCount > 0 && `${String(pullCount)} PR${pullCount === 1 ? '' : 's'} · `}
                    {branchCount} branch{branchCount === 1 ? '' : 'es'}
                  </span>
                )
              )}
            </div>

            {!ghAvailable && (
              <p className="mx-2 mt-1 flex items-start gap-2 rounded-md bg-chrome-bg-hover px-2.5 py-1.5 text-xs leading-snug text-chrome-fg-muted">
                <GitPullRequest size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  Pull requests need the <code>gh</code> CLI, installed and authenticated (<code>gh auth status</code>).
                  Branches still work without it.
                </span>
              </p>
            )}

            <ul ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2 pt-1">
              {rows.map((row, index) => (
                <ExploreRow
                  key={row.key}
                  index={index}
                  row={row}
                  active={index === activeIndex}
                  existing={reviewByBranch.get(row.kind === 'pull' ? row.pull.headRefName : row.branch.name)}
                  opening={opening === row.key}
                  disabled={opening !== null}
                  onHover={() => setActiveIndex(index)}
                  onOpen={() => void open(row)}
                />
              ))}

              {!loadingList && repoId !== null && rows.length === 0 && (
                <li className="flex h-full items-center justify-center px-4 text-center text-xs leading-snug text-chrome-fg-muted">
                  {filter.trim() === '' ? 'No branches or pull requests found.' : `Nothing matches "${filter.trim()}".`}
                </li>
              )}
            </ul>

            {/* Same footer strip as the command palette: key hints left, a
                scope note right when the list is the newest N rather than all. */}
            <div className="flex h-8 shrink-0 items-center gap-3 border-t border-chrome-border px-3.5 text-micro text-chrome-fg-subtle">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> open
              </span>
              <div className="flex-1" />
              {truncated && <span>{BRANCH_LIMIT} most recent branches — type to search the rest</span>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ExploreRow({
  index,
  row,
  active,
  existing,
  opening,
  disabled,
  onHover,
  onOpen,
}: {
  index: number;
  row: Row;
  active: boolean;
  existing: Review | undefined;
  opening: boolean;
  disabled: boolean;
  onHover: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const isPr = row.kind === 'pull';
  const Icon = isPr ? GitPullRequest : GitBranch;
  const title = isPr ? row.pull.title : row.branch.name;

  // Second line: the pieces that tell two similarly named rows apart.
  const meta: string[] = [];
  if (isPr) {
    meta.push(`${row.pull.headRefName} → ${row.pull.baseRefName}`);
    if (row.pull.authorLogin !== null) meta.push(row.pull.authorLogin);
  } else {
    if (row.branch.subject !== null) meta.push(row.branch.subject);
    if (row.branch.authorName !== null) meta.push(row.branch.authorName);
    meta.push(row.branch.tipSha.slice(0, 7));
  }

  return (
    <li data-index={index}>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onOpen}
        disabled={disabled}
        aria-current={active}
        className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
          active ? 'chrome-row-selected' : 'hover:bg-chrome-bg-hover'
        }`}
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
            <span className="truncate text-body font-medium text-chrome-fg">{title}</span>
            {isPr && (
              <span className="shrink-0 rounded-[3px] bg-chrome-bg-hover px-1 text-micro tabular-nums text-chrome-fg-muted">
                #{row.pull.number}
              </span>
            )}
            {isPr && row.pull.isDraft && (
              <span className="shrink-0 rounded-[3px] bg-chrome-bg-hover px-1 text-micro text-chrome-fg-muted">draft</span>
            )}
            {!isPr && !row.branch.hasLocalRef && (
              <span
                className="flex shrink-0 items-center gap-0.5 rounded-[3px] bg-chrome-bg-hover px-1 text-micro text-chrome-fg-muted"
                title="Only exists on origin — not checked out locally"
              >
                <Cloud size={10} strokeWidth={2} aria-hidden />
                origin
              </span>
            )}
          </span>
          {meta.length > 0 && <span className="truncate text-micro text-chrome-fg-subtle">{meta.join(' · ')}</span>}
        </span>

        {existing !== undefined && (
          <span
            className="flex shrink-0 items-center gap-1 text-micro text-chrome-fg-muted"
            title={existing.status === 'archived' ? 'You have an archived review of this' : 'You have an open review of this'}
          >
            <Check size={13} strokeWidth={2} className="text-chrome-success" aria-hidden />
            {existing.status === 'archived' ? 'archived' : 'reviewing'}
          </span>
        )}
        <span className="w-14 shrink-0 text-right text-micro tabular-nums text-chrome-fg-subtle">
          {relativeTime(row.when)}
        </span>
        {opening && (
          <Loader2 size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-chrome-fg-subtle" aria-hidden />
        )}
      </button>
    </li>
  );
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-chrome-bg-hover px-1 font-sans text-micro text-chrome-fg-muted">
      {children}
    </kbd>
  );
}
