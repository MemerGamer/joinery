/**
 * Settings (`#/settings`), reached from the gear on Homebase or "Open
 * settings" in ⌘K. One column of panels:
 *
 *  - Appearance: the dark and the light diff theme, picked separately,
 *    each over a sample drawn in it (the same two slots ⌘K's `#` tabs fill).
 *  - Repositories: what's registered, its forge, and removing one.
 *  - Integrations: is `claude` there, and can each forge host be asked.
 *  - Full Disk Access: the macOS grant for the installed server.
 *  - Data: where it lives and how big, clearing the caches, and the
 *    archived reviews, which nothing else lists, to reopen or delete.
 *
 * Everything server-side is read when the page opens; nothing here is a
 * stored server setting.
 */
import type { DataUsage, FullDiskAccess, Integrations, Repo, Review, ReviewSummary } from '@joinery/core';
import {
  Archive,
  ArrowLeft,
  Check,
  Database,
  FolderGit2,
  HardDrive,
  Moon,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, callApi } from '../../lib/apiClient.ts';
import { useGlobalKeymap } from '../../lib/keymap.ts';
import { relativeTime } from '../../lib/relativeTime.ts';
import { goHomebase, goReview } from '../../lib/router.ts';
import { listThemeOptions } from '../../lib/themes.ts';
import { useHomeData } from '../../state/HomeData.tsx';
import { useTheme, type ChromeMode } from '../../state/ThemeContext.tsx';
import { CommandPalette } from '../CommandPalette.tsx';
import { ConfirmDelete } from '../ConfirmDelete.tsx';
import { repoLabel } from '../Explore.tsx';
import { FolderPicker } from '../home/FolderPicker.tsx';
import { Panel } from '../home/Panel.tsx';
import { Chip, type Tone } from '../home/primitives.tsx';
import { ThemeSample } from './ThemeSample.tsx';

/** How long to wait for the server to come back after a restart before giving up. */
const RESTART_TIMEOUT_MS = 60_000;
const RESTART_POLL_MS = 1_000;

/** Panels clip by default; these let a row's confirm popover hang past the panel's edge. */
const OVERFLOW = 'overflow-visible!';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.hint !== undefined ? `${err.message}. ${err.hint}` : err.message;
  return fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** A server read that the page shows as loading, failed, or loaded, and can re-run. */
function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .then((value) => {
        if (!live) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err, 'Could not load.'));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // `load` is a stable module-level call per use site; `tick` re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function Settings(): React.JSX.Element {
  useEffect(() => {
    document.title = 'Settings · Joinery';
    return () => {
      document.title = 'Joinery';
    };
  }, []);
  // ⌘K / ⌘⇧P, as on Homebase.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'command' | undefined>(undefined);
  useGlobalKeymap({
    openPalette: () => {
      setPaletteMode(undefined);
      setPaletteOpen(true);
    },
    openPaletteCommands: () => {
      setPaletteMode('command');
      setPaletteOpen(true);
    },
  });

  return (
    <div className="home-shell h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 pt-6 pb-16">
          <header className="flex items-center gap-2">
            <button type="button" onClick={goHomebase} aria-label="Back to Homebase" title="Back to Homebase" className="chrome-icon-btn">
              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <h1 className="text-lg font-semibold tracking-tight text-chrome-fg">Settings</h1>
          </header>
          <AppearancePanel />
          <ReposPanel />
          <IntegrationsPanel />
          <FullDiskAccessPanel />
          <DataPanel />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialMode={paletteMode} />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-3 py-5 text-center text-xs text-chrome-fg-muted">{children}</p>;
}

function ErrorLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-3 py-2 text-xs text-chrome-danger">{children}</p>;
}

/** One label/value row inside a panel. */
function Row({
  icon,
  title,
  detail,
  children,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2">
      {icon !== undefined && (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-chrome-fg-subtle [&>svg]:size-4" aria-hidden>
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-chrome-fg">{title}</span>
        {detail !== undefined && <span className="truncate text-micro text-chrome-fg-subtle">{detail}</span>}
      </span>
      {children !== undefined && <span className="flex shrink-0 items-center gap-1.5">{children}</span>}
    </li>
  );
}

// --- Appearance ---

function AppearancePanel(): React.JSX.Element {
  const { chromeMode, diffTheme, setDiffTheme } = useTheme();
  const options = useMemo(() => listThemeOptions(), []);
  return (
    <Panel icon={<Palette />} title="Appearance" className={OVERFLOW} bodyClassName={`px-3 pb-3 ${OVERFLOW}`}>
      <p className="pb-3 text-xs text-chrome-fg-muted">
        One theme for dark mode and one for light; switching modes swaps between them. ⌘K's <code>#</code> picks them too.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['dark', 'light'] as const).map((slot) => (
          <ThemeColumn
            key={slot}
            slot={slot}
            inUse={slot === chromeMode}
            value={diffTheme[slot]}
            options={options.filter((o) => o.colorScheme === undefined || o.colorScheme === slot)}
            onChange={(name) => setDiffTheme({ ...diffTheme, [slot]: name })}
          />
        ))}
      </div>
    </Panel>
  );
}

function ThemeColumn({
  slot,
  inUse,
  value,
  options,
  onChange,
}: {
  slot: ChromeMode;
  inUse: boolean;
  value: string;
  options: ReturnType<typeof listThemeOptions>;
  onChange: (name: string) => void;
}): React.JSX.Element {
  const id = `theme-${slot}`;
  const colorblind = options.filter((o) => o.colorblindSafe);
  const rest = options.filter((o) => !o.colorblindSafe);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {slot === 'dark' ? <Moon size={13} strokeWidth={1.75} className="text-chrome-fg-subtle" aria-hidden /> : <Sun size={13} strokeWidth={1.75} className="text-chrome-fg-subtle" aria-hidden />}
        <label htmlFor={id} className="text-xs font-medium text-chrome-fg">
          {slot === 'dark' ? 'Dark' : 'Light'}
        </label>
        {inUse && <Chip tone="accent">in use</Chip>}
      </div>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-chrome-border bg-chrome-bg-raised px-2 text-body text-chrome-fg"
      >
        <optgroup label="Colorblind-safe">
          {colorblind.map((o) => (
            <option key={o.name} value={o.name}>
              {o.displayName}
            </option>
          ))}
        </optgroup>
        <optgroup label="All themes">
          {rest.map((o) => (
            <option key={o.name} value={o.name}>
              {o.displayName}
            </option>
          ))}
        </optgroup>
      </select>
      <ThemeSample name={value} />
    </div>
  );
}

// --- Repositories ---

const FORGE_LABEL: Record<NonNullable<Repo['forge']>, string> = { github: 'GitHub', gitlab: 'GitLab', none: 'No forge' };

function ReposPanel(): React.JSX.Element {
  const { repos, loading, refresh } = useHomeData();
  const [adding, setAdding] = useState(false);
  const sorted = useMemo(() => [...repos].sort((a, b) => repoLabel(a).localeCompare(repoLabel(b))), [repos]);

  const remove = async (repo: Repo) => {
    try {
      await callApi('deleteRepo', { params: [repo.id] });
    } catch (err) {
      throw new Error(errorText(err, 'Could not remove the repository.'));
    } finally {
      void refresh();
    }
  };

  return (
    <Panel
      icon={<FolderGit2 />}
      title="Repositories"
      className={OVERFLOW}
      bodyClassName={`px-1 pb-1.5 ${OVERFLOW}`}
      count={repos.length}
      actions={
        <button type="button" onClick={() => setAdding(true)} className="chrome-btn">
          <Plus size={13} strokeWidth={1.75} aria-hidden />
          Add
        </button>
      }
    >
      {adding && (
        <FolderPicker
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {loading && repos.length === 0 ? (
        <Empty>Loading…</Empty>
      ) : sorted.length === 0 ? (
        <Empty>No repositories yet.</Empty>
      ) : (
        <ul className="flex flex-col">
          {sorted.map((r) => (
            <Row
              key={r.id}
              icon={<FolderGit2 />}
              title={repoLabel(r)}
              detail={r.remoteHost !== null ? `${r.rootPath} · ${r.remoteHost}` : r.rootPath}
            >
              <Chip>{r.forge === null ? 'Detecting…' : FORGE_LABEL[r.forge]}</Chip>
              <ConfirmDelete
                prompt={`Remove ${repoLabel(r)}? Its reviews, threads and reading orders are deleted. The clone itself is left alone.`}
                onConfirm={() => remove(r)}
                confirmLabel="Remove"
                triggerLabel={`Remove ${repoLabel(r)}`}
                triggerClassName="chrome-icon-btn"
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden />
              </ConfirmDelete>
            </Row>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- Integrations ---

const REASON: Record<NonNullable<Integrations['hosts'][number]['reason']>, { label: string; tone: Tone }> = {
  'missing-cli': { label: 'Not installed', tone: 'danger' },
  'not-authenticated': { label: 'Not signed in', tone: 'warning' },
  unreachable: { label: "Can't reach host", tone: 'warning' },
};

function hostHint(cli: 'gh' | 'glab', host: string, reason: Integrations['hosts'][number]['reason']): string | undefined {
  if (reason === 'missing-cli') return cli === 'gh' ? 'brew install gh' : 'brew install glab';
  if (reason === 'not-authenticated') return `${cli} auth login --hostname ${host}`;
  if (reason === 'unreachable') return 'Signed in, but the host did not answer. A VPN?';
  return undefined;
}

function IntegrationsPanel(): React.JSX.Element {
  const { data, error, loading, reload } = useLoad(() => callApi('integrations'));
  return (
    <Panel
      icon={<Plug />}
      title="Integrations"
      className={OVERFLOW}
      bodyClassName={`px-1 pb-1.5 ${OVERFLOW}`}
      actions={
        <button type="button" onClick={reload} aria-label="Check again" title="Check again" className="chrome-icon-btn">
          <RefreshCw size={14} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
        </button>
      }
    >
      {error !== null && <ErrorLine>{error}</ErrorLine>}
      {data === null ? (
        error === null && <Empty>Checking…</Empty>
      ) : (
        <ul className={`flex flex-col transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <Row
            title="Claude Code"
            detail={
              data.claude.path !== null
                ? data.claude.bundled
                  ? `${data.claude.path} · a source checkout runs the Agent SDK's own copy`
                  : data.claude.path
                : data.claude.bundled
                  ? "Not on PATH · a source checkout runs the Agent SDK's own copy"
                  : 'Install it and run `claude` once to sign in; agent replies need it'
            }
          >
            {data.claude.path !== null || data.claude.bundled ? <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Found</Chip> : <Chip tone="danger">Not found</Chip>}
          </Row>
          {data.clis.map((c) => (
            <Row key={c.cli} title={<code>{c.cli}</code>} detail={c.path ?? (c.cli === 'gh' ? 'Needed for GitHub pull requests' : 'Needed for GitLab merge requests')}>
              {c.path !== null ? <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Installed</Chip> : <Chip>Not installed</Chip>}
            </Row>
          ))}
          {data.hosts.map((h) => (
            <Row
              key={h.host}
              title={h.host}
              detail={hostHint(h.cli, h.host, h.reason) ?? `${h.cli} · ${String(h.repos)} ${h.repos === 1 ? 'repository' : 'repositories'}`}
            >
              {h.reason === null ? (
                <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Signed in</Chip>
              ) : (
                <Chip tone={REASON[h.reason].tone}>{REASON[h.reason].label}</Chip>
              )}
            </Row>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- Full Disk Access ---

/** Polls until the server answers again after a restart; resolves false on timeout. */
async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  // Give the old process a moment to go away, so the first answer isn't its.
  await new Promise((r) => setTimeout(r, RESTART_POLL_MS * 2));
  while (Date.now() < deadline) {
    try {
      await callApi('version');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
    }
  }
  return false;
}

function FullDiskAccessPanel(): React.JSX.Element {
  const { data, error, loading, reload } = useLoad(() => callApi('fullDiskAccess'));
  const [busy, setBusy] = useState<'open' | 'restart' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const openSettings = async () => {
    setBusy('open');
    setActionError(null);
    try {
      await callApi('openFullDiskAccess');
    } catch (err) {
      setActionError(errorText(err, 'Could not open System Settings.'));
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    setBusy('restart');
    setActionError(null);
    try {
      await callApi('restartServer');
      if (!(await waitForServer())) setActionError('The server did not come back. Check `joinery service status`.');
      reload();
    } catch (err) {
      setActionError(errorText(err, 'Could not restart the server.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      icon={<ShieldCheck />}
      title="Full Disk Access"
      className={OVERFLOW}
      actions={
        data?.applies === true && (
          <button type="button" onClick={reload} aria-label="Check again" title="Check again" className="chrome-icon-btn">
            <RefreshCw size={14} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
          </button>
        )
      }
      bodyClassName={`px-3 pb-3 ${OVERFLOW}`}
    >
      {error !== null && <ErrorLine>{error}</ErrorLine>}
      {data === null ? (
        error === null && <Empty>Checking…</Empty>
      ) : !data.applies ? (
        <p className="text-xs text-chrome-fg-muted">
          Only the installed app on macOS needs this. In a source checkout the server runs with your terminal's permissions, so grant Full Disk Access to the terminal instead.
        </p>
      ) : (
        <FullDiskAccessBody data={data} busy={busy} onOpen={() => void openSettings()} onRestart={() => void restart()} />
      )}
      {actionError !== null && <p className="pt-2 text-xs text-chrome-danger">{actionError}</p>}
    </Panel>
  );
}

function FullDiskAccessBody({
  data,
  busy,
  onOpen,
  onRestart,
}: {
  data: FullDiskAccess;
  busy: 'open' | 'restart' | null;
  onOpen: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {data.granted === true ? (
          <Chip tone="success" icon={<Check size={11} strokeWidth={2.5} />}>Granted</Chip>
        ) : (
          <Chip tone="warning">Not granted</Chip>
        )}
        <span className="text-xs text-chrome-fg-muted">
          {data.granted === true
            ? 'Folders like Desktop, Documents and iCloud Drive open without a prompt.'
            : 'macOS asks before Joinery may open Desktop, Documents, Downloads, iCloud Drive or external drives, and remembers a "Don\'t Allow".'}
        </span>
      </div>
      {data.granted !== true && (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-chrome-fg-muted">
          <li>Open System Settings: it lands on Full Disk Access, with the Joinery binary shown in Finder.</li>
          <li>Drag the binary into the list (or click + and pick it), and turn its switch on.</li>
          <li>Restart the server so the grant applies.</li>
        </ol>
      )}
      {data.binary !== null && <p className="truncate font-mono text-micro text-chrome-fg-subtle" title={data.binary}>{data.binary}</p>}
      <div className="flex items-center gap-1.5">
        {data.granted !== true && (
          <button type="button" onClick={onOpen} disabled={busy !== null} className="chrome-btn-primary">
            Open System Settings
          </button>
        )}
        {data.canRestart ? (
          <button type="button" onClick={onRestart} disabled={busy !== null} className="chrome-btn">
            <RefreshCw size={13} strokeWidth={1.75} className={busy === 'restart' ? 'animate-spin' : ''} aria-hidden />
            {busy === 'restart' ? 'Restarting…' : 'Restart server'}
          </button>
        ) : (
          data.granted !== true && <span className="text-micro text-chrome-fg-subtle">Then restart `joinery serve`.</span>
        )}
      </div>
    </div>
  );
}

// --- Data ---

function DataPanel(): React.JSX.Element {
  const usage = useLoad(() => callApi('dataUsage'));
  const archived = useLoad(() => callApi('listReviews', { query: { status: 'archived' } }));
  const { repos, unarchiveReview } = useHomeData();
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);

  const clear = async () => {
    setClearing(true);
    setClearResult(null);
    try {
      const res = await callApi('clearCaches');
      setClearResult(
        `Removed ${String(res.worktreesRemoved)} ${res.worktreesRemoved === 1 ? 'worktree' : 'worktrees'} and ${String(res.cachedAnswersRemoved)} cached ${res.cachedAnswersRemoved === 1 ? 'answer' : 'answers'}.`,
      );
    } catch (err) {
      throw new Error(errorText(err, 'Could not clear the caches.'));
    } finally {
      setClearing(false);
      usage.reload();
    }
  };

  return (
    <Panel icon={<Database />} title="Data" className={OVERFLOW} bodyClassName={`px-1 pb-2 ${OVERFLOW}`}>
      {usage.error !== null && <ErrorLine>{usage.error}</ErrorLine>}
      {usage.data === null ? (
        usage.error === null && <Empty>Measuring…</Empty>
      ) : (
        <UsageRows usage={usage.data} />
      )}
      <div className="flex items-center gap-2 px-3 pt-1 pb-3">
        <ConfirmDelete
          prompt="Clear the agent worktrees and cached answers? They're rebuilt when next needed."
          onConfirm={clear}
          confirmLabel="Clear"
          triggerClassName="chrome-btn"
        >
          <Trash2 size={13} strokeWidth={1.75} aria-hidden />
          {clearing ? 'Clearing…' : 'Clear caches'}
        </ConfirmDelete>
        {clearResult !== null && <span className="text-xs text-chrome-fg-muted">{clearResult}</span>}
      </div>

      <div className="border-t border-chrome-border pt-2">
        <div className="flex items-center gap-2 px-3 pb-1">
          <Archive size={13} strokeWidth={1.75} className="text-chrome-fg-subtle" aria-hidden />
          <h3 className="text-xs font-medium text-chrome-fg">Archived reviews</h3>
          {archived.data !== null && (
            <span className="rounded-sm bg-chrome-bg-hover px-1 text-micro font-medium tabular-nums text-chrome-fg-muted">{archived.data.reviews.length}</span>
          )}
        </div>
        {archived.error !== null && <ErrorLine>{archived.error}</ErrorLine>}
        {archived.data === null ? (
          archived.error === null && <Empty>Loading…</Empty>
        ) : archived.data.reviews.length === 0 ? (
          <Empty>Nothing archived.</Empty>
        ) : (
          <ArchivedList
            reviews={archived.data.reviews}
            summaries={archived.data.summaries}
            repos={repos}
            onReopen={async (id) => {
              await unarchiveReview(id);
              archived.reload();
            }}
            onDelete={async (id) => {
              try {
                await callApi('deleteReview', { params: [id] });
              } catch (err) {
                throw new Error(errorText(err, 'Could not delete the review.'));
              }
              archived.reload();
              usage.reload();
            }}
          />
        )}
      </div>
    </Panel>
  );
}

function UsageRows({ usage }: { usage: DataUsage }): React.JSX.Element {
  return (
    <ul className="flex flex-col">
      <Row icon={<HardDrive />} title="Data folder" detail={usage.root}>
        <span className="text-xs tabular-nums text-chrome-fg-muted">
          {formatBytes(usage.databaseBytes + usage.worktrees.bytes)}
        </span>
      </Row>
      <Row title="Database" detail="Reviews, threads, reading orders, viewed checks">
        <span className="text-xs tabular-nums text-chrome-fg-muted">{formatBytes(usage.databaseBytes)}</span>
      </Row>
      <Row title="Agent worktrees" detail={`${String(usage.worktrees.count)} checkouts for agent runs · cache`}>
        <span className="text-xs tabular-nums text-chrome-fg-muted">{formatBytes(usage.worktrees.bytes)}</span>
      </Row>
      <Row title="Cached answers" detail={`${String(usage.cachedAnswers.count)} PR lists, PR details and review stats · cache, inside the database`}>
        <span className="text-xs tabular-nums text-chrome-fg-muted">{formatBytes(usage.cachedAnswers.bytes)}</span>
      </Row>
    </ul>
  );
}

function ArchivedList({
  reviews,
  summaries,
  repos,
  onReopen,
  onDelete,
}: {
  reviews: Review[];
  summaries: ReviewSummary[];
  repos: Repo[];
  onReopen: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [reopening, setReopening] = useState<string | null>(null);
  const summaryById = useMemo(() => new Map(summaries.map((s) => [s.reviewId, s])), [summaries]);
  const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const lastActivity = (r: Review) => summaryById.get(r.id)?.lastActivityAt ?? r.createdAt;
  const sorted = [...reviews].sort((a, b) => lastActivity(b) - lastActivity(a));

  return (
    <ul className="flex flex-col">
      {sorted.map((r) => {
        const s = summaryById.get(r.id);
        const repo = repoById.get(r.repoId);
        const threads = (s?.openThreads ?? 0) + (s?.resolvedThreads ?? 0);
        const name = s?.title ?? r.branch ?? r.pinnedSha?.slice(0, 7) ?? r.id;
        const where = [
          repo !== undefined ? repoLabel(repo) : null,
          r.prNumber !== null ? `#${String(r.prNumber)}` : null,
          r.branch,
          `${String(threads)} ${threads === 1 ? 'thread' : 'threads'}`,
          `active ${relativeTime(lastActivity(r))}`,
        ].filter((x): x is string => x !== null);
        return (
          <Row key={r.id} title={<button type="button" onClick={() => goReview(r.id)} className="truncate text-left hover:underline">{name}</button>} detail={where.join(' · ')}>
            <button
              type="button"
              disabled={reopening !== null}
              onClick={() => {
                setReopening(r.id);
                void onReopen(r.id).finally(() => setReopening(null));
              }}
              className="chrome-btn"
            >
              {reopening === r.id ? 'Reopening…' : 'Reopen'}
            </button>
            <ConfirmDelete
              prompt="Delete this review for good? Its threads, reading order and viewed checks go with it."
              onConfirm={() => onDelete(r.id)}
              triggerLabel="Delete review"
              triggerClassName="chrome-icon-btn"
            >
              <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            </ConfirmDelete>
          </Row>
        );
      })}
    </ul>
  );
}
