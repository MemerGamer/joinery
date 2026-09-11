/**
 * `Cmd+K` command palette (SPEC §11): a Linear-style, mode-scoped launcher.
 *
 * The default (root) mode ranks a small, bounded set of jump targets — files,
 * reading-order steps, open threads — rather than dumping every file, every
 * thread, and all 75 themes into one flat list at once. Three explicit
 * sub-modes are reached by typing a leading character in the search box,
 * exactly like VS Code's palette:
 *
 *   `>`  commands   — actions: generate reading order, switch revision,
 *                     toggle panels, diff style, expand/collapse all
 *   `#`  themes     — all 75 diff themes (SPEC §6, *ship all 75*), never a
 *                     truncated slice
 *   `@`  reviews    — switch to another open review
 *
 * The trigger character lives directly in the (controlled) search string, so
 * "back" is just deleting it: Backspace on `#dra` → `#` → `` walks
 * theme-search → theme-home → root for free, with no separate navigation
 * stack to keep in sync. `Escape` clears the query first and only closes the
 * palette once it's already empty (so a sub-mode collapses back to root
 * before the palette itself closes).
 *
 * There is no standalone "ask agent" command here: the API only supports
 * asking an agent as part of posting a thread reply (`createThread`/`reply`'s
 * `askAgent` flag, bound to `Cmd+Enter` in the comment composer) — there is
 * no draft-thread context inside the palette to attach that to, so it does
 * not pretend to have one.
 */
import { Command, defaultFilter } from 'cmdk';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  ListOrdered,
  MessageSquare,
  Palette,
  PanelLeft,
  PanelRight,
  Rows2,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import { listThemeOptions, type ThemeOption } from '../lib/themes.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';

type Mode = 'root' | 'command' | 'theme' | 'review';

function parseSearch(raw: string): { mode: Mode; query: string } {
  if (raw.startsWith('>')) return { mode: 'command', query: raw.slice(1).trimStart() };
  if (raw.startsWith('#')) return { mode: 'theme', query: raw.slice(1).trimStart() };
  if (raw.startsWith('@')) return { mode: 'review', query: raw.slice(1).trimStart() };
  return { mode: 'root', query: raw };
}

const MODE_PLACEHOLDER: Record<Mode, string> = {
  root: 'Jump to a file, step, or thread… (try > # or @)',
  command: 'Run a command…',
  theme: 'Switch theme…',
  review: 'Switch review…',
};

const MODE_LABEL: Record<Mode, string> = {
  root: 'Jump to',
  command: 'Commands',
  theme: 'Themes',
  review: 'Reviews',
};

/** Root-mode groups show at most this many rows until the user actually types a query. */
const ROOT_CAP = 6;

const ITEM_CLASS =
  'flex items-center gap-2 rounded px-2 py-1.5 text-xs text-chrome-fg outline-hidden data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg [&_svg]:shrink-0 [&_svg]:text-chrome-fg-subtle data-[selected=true]:[&_svg]:text-chrome-accent-fg';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const review = useReview();
  const { chromeMode, diffTheme, setDiffTheme } = useTheme();
  const [search, setSearch] = useState('');
  const [reviewList, setReviewList] = useState<{ id: string; branch: string | null }[]>([]);

  const { mode, query } = parseSearch(search);

  useEffect(() => {
    if (!open) return;
    callApi('listReviews')
      .then((res) => setReviewList(res.reviews.map((r) => ({ id: r.id, branch: r.branch }))))
      .catch(() => undefined);
  }, [open]);

  // Defect: search query was never reset on close, so reopening showed
  // stale filtering. Reset back to root with an empty query every time.
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  // listThemeOptions() was being called on every render — memoize it, and
  // never slice it: all 75 themes stay reachable (SPEC §6).
  const themeOptions = useMemo(() => listThemeOptions(), []);
  const colorblindThemes = useMemo(() => themeOptions.filter((o) => o.colorblindSafe), [themeOptions]);
  const otherThemes = useMemo(() => themeOptions.filter((o) => !o.colorblindSafe), [themeOptions]);
  const activeThemeName = chromeMode === 'dark' ? diffTheme.dark : diffTheme.light;

  const close = () => onOpenChange(false);

  // cmdk's own fuzzy filter (`defaultFilter`, from the `command-score`
  // library), but scored against the query with its mode prefix stripped —
  // so `#dra` filters the theme list by `dra`, not by the literal `#dra`.
  const filter = useCallback((value: string, rawSearch: string): number => {
    const { query: q } = parseSearch(rawSearch);
    if (q === '') return 1;
    return defaultFilter(value, q);
  }, []);

  const goToFile = (path: string) => {
    review.setSelectedPath(path);
    review.codeViewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
    close();
  };

  const files = query === '' ? review.fileList.slice(0, ROOT_CAP) : review.fileList;
  const allSteps = review.readingOrder?.steps ?? [];
  const steps = query === '' ? allSteps.slice(0, ROOT_CAP) : allSteps;
  const openThreads = review.threads.filter((t) => t.status === 'open');
  const threads = query === '' ? openThreads.slice(0, ROOT_CAP) : openThreads;

  const currentReview = review.review;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]"
      shouldFilter
      filter={filter}
      loop
    >
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg-raised shadow-[var(--chrome-shadow)]">
        <div className="flex items-center gap-2 border-b border-chrome-border px-3 py-2.5">
          {mode !== 'root' && (
            <span className="shrink-0 rounded border border-chrome-border-strong px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-chrome-fg-subtle">
              {MODE_LABEL[mode]}
            </span>
          )}
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              // First Escape backs a sub-mode out to root; only a second
              // Escape (query already empty) falls through to Radix's own
              // handler and closes the dialog.
              if (e.key === 'Escape' && search !== '') {
                e.preventDefault();
                setSearch('');
              }
            }}
            placeholder={MODE_PLACEHOLDER[mode]}
            className="w-full bg-transparent text-sm text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-1.5">
          <Command.Empty className="p-3 text-center text-xs text-chrome-fg-muted">No results.</Command.Empty>

          {mode === 'root' && (
            <>
              {files.length > 0 && (
                <Group heading="Files">
                  {files.map((f) => (
                    <Command.Item key={f.path} value={`file ${f.path}`} onSelect={() => goToFile(f.path)} className={ITEM_CLASS}>
                      <FileText size={14} strokeWidth={1.5} aria-hidden />
                      <span className="truncate">{f.path}</span>
                    </Command.Item>
                  ))}
                </Group>
              )}

              {steps.length > 0 && (
                <Group heading="Steps">
                  {steps.map((step) => (
                    <Command.Item
                      key={step.id}
                      value={`step ${step.title}`}
                      onSelect={() => {
                        const first = step.files[0];
                        if (first !== undefined) goToFile(first.path);
                        else close();
                      }}
                      className={ITEM_CLASS}
                    >
                      <ListOrdered size={14} strokeWidth={1.5} aria-hidden />
                      <span className="truncate">{step.title}</span>
                    </Command.Item>
                  ))}
                </Group>
              )}

              {threads.length > 0 && (
                <Group heading="Threads">
                  {threads.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`thread ${t.path} ${t.comments[0]?.bodyMd ?? ''}`}
                      onSelect={() => {
                        review.setSelectedPath(t.path);
                        review.codeViewRef.current?.scrollTo({
                          type: 'line',
                          id: t.path,
                          lineNumber: t.startLine,
                          side: t.side === 'old' ? 'deletions' : 'additions',
                        });
                        review.toggleThreadsPanel();
                        close();
                      }}
                      className={ITEM_CLASS}
                    >
                      <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
                      <span className="truncate">
                        {t.path}:{t.startLine} — {t.comments[0]?.bodyMd.slice(0, 60) ?? ''}
                      </span>
                    </Command.Item>
                  ))}
                </Group>
              )}

              <Group heading="More">
                <Command.Item value="commands all actions run" onSelect={() => setSearch('>')} className={ITEM_CLASS}>
                  <Terminal size={14} strokeWidth={1.5} aria-hidden />
                  All commands…
                  <Hint>&gt;</Hint>
                </Command.Item>
                <Command.Item value="theme switch appearance colors" onSelect={() => setSearch('#')} className={ITEM_CLASS}>
                  <Palette size={14} strokeWidth={1.5} aria-hidden />
                  Switch theme…
                  <Hint>#</Hint>
                </Command.Item>
                <Command.Item value="review switch open another" onSelect={() => setSearch('@')} className={ITEM_CLASS}>
                  <GitBranch size={14} strokeWidth={1.5} aria-hidden />
                  Switch review…
                  <Hint>@</Hint>
                </Command.Item>
              </Group>
            </>
          )}

          {mode === 'command' && (
            <Group heading="Commands">
              {currentReview !== null && (
                <Command.Item
                  value="generate reading order"
                  onSelect={() => {
                    void review.generateReadingOrder();
                    close();
                  }}
                  className={ITEM_CLASS}
                >
                  <Sparkles size={14} strokeWidth={1.5} aria-hidden />
                  Generate reading order
                </Command.Item>
              )}
              {(['working', 'head', 'pr'] as const).map((rev) => (
                <Command.Item
                  key={rev}
                  value={`switch revision ${rev}`}
                  onSelect={() => {
                    void review.setRevision(rev);
                    close();
                  }}
                  className={ITEM_CLASS}
                >
                  <GitCommitHorizontal size={14} strokeWidth={1.5} aria-hidden />
                  Switch to {rev}
                  {review.reviewState?.currentRevision === rev && (
                    <Check size={13} strokeWidth={2} className="ml-auto" aria-hidden />
                  )}
                </Command.Item>
              ))}
              <Command.Item
                value="toggle left panel file tree"
                onSelect={() => {
                  review.toggleLeftPanel();
                  close();
                }}
                className={ITEM_CLASS}
              >
                <PanelLeft size={14} strokeWidth={1.5} aria-hidden />
                Toggle left panel
              </Command.Item>
              <Command.Item
                value="toggle right panel reading order"
                onSelect={() => {
                  review.toggleRightPanel();
                  close();
                }}
                className={ITEM_CLASS}
              >
                <PanelRight size={14} strokeWidth={1.5} aria-hidden />
                Toggle right panel
              </Command.Item>
              <Command.Item
                value="toggle threads panel"
                onSelect={() => {
                  review.toggleThreadsPanel();
                  close();
                }}
                className={ITEM_CLASS}
              >
                <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
                Toggle threads panel
              </Command.Item>
              <Command.Item
                value="diff style unified split toggle"
                onSelect={() => {
                  review.setDiffStyle(review.diffStyle === 'split' ? 'unified' : 'split');
                  close();
                }}
                className={ITEM_CLASS}
              >
                {review.diffStyle === 'split' ? (
                  <Rows2 size={14} strokeWidth={1.5} aria-hidden />
                ) : (
                  <Columns2 size={14} strokeWidth={1.5} aria-hidden />
                )}
                Switch to {review.diffStyle === 'split' ? 'unified' : 'split'} diff
              </Command.Item>
              <Command.Item
                value="expand all files"
                onSelect={() => {
                  review.expandAllFiles();
                  close();
                }}
                className={ITEM_CLASS}
              >
                <ChevronsUpDown size={14} strokeWidth={1.5} aria-hidden />
                Expand all files
              </Command.Item>
              <Command.Item
                value="collapse all files"
                onSelect={() => {
                  review.collapseAllFiles();
                  close();
                }}
                className={ITEM_CLASS}
              >
                <ChevronsDownUp size={14} strokeWidth={1.5} aria-hidden />
                Collapse all files
              </Command.Item>
            </Group>
          )}

          {mode === 'theme' && (
            <>
              {colorblindThemes.length > 0 && (
                <Group heading="Colorblind-safe">
                  {colorblindThemes.map((opt) => (
                    <ThemeItem
                      key={opt.name}
                      opt={opt}
                      active={opt.name === activeThemeName}
                      onSelect={() => {
                        setDiffTheme({ ...diffTheme, [chromeMode]: opt.name });
                        close();
                      }}
                    />
                  ))}
                </Group>
              )}
              {otherThemes.length > 0 && (
                <Group heading="All themes">
                  {otherThemes.map((opt) => (
                    <ThemeItem
                      key={opt.name}
                      opt={opt}
                      active={opt.name === activeThemeName}
                      onSelect={() => {
                        setDiffTheme({ ...diffTheme, [chromeMode]: opt.name });
                        close();
                      }}
                    />
                  ))}
                </Group>
              )}
            </>
          )}

          {mode === 'review' && reviewList.length > 0 && (
            <Group heading="Reviews">
              {reviewList.map((r) => (
                <Command.Item
                  key={r.id}
                  value={`review ${r.branch ?? r.id}`}
                  onSelect={() => {
                    goReview(r.id);
                    close();
                  }}
                  className={ITEM_CLASS}
                >
                  <GitBranch size={14} strokeWidth={1.5} aria-hidden />
                  <span className="truncate">{r.branch ?? r.id}</span>
                  {r.id === currentReview?.id && <Check size={13} strokeWidth={2} className="ml-auto" aria-hidden />}
                </Command.Item>
              ))}
            </Group>
          )}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

/**
 * A group heading, styled on the heading node itself rather than via
 * `className` on `Command.Group` — that prop styles the whole group
 * subtree (cmdk renders it on the group's outer wrapper), which is what let
 * the tiny/uppercase/subtle heading styles bleed onto every item beneath it.
 */
function Group({ heading, children }: { heading: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Command.Group
      heading={
        <span className="block px-2 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-chrome-fg-subtle">
          {heading}
        </span>
      }
    >
      <div className="flex flex-col gap-0.5">{children}</div>
    </Command.Group>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="ml-auto rounded border border-chrome-border-strong px-1.5 py-0.5 text-[10px] text-chrome-fg-subtle">
      {children}
    </kbd>
  );
}

function ThemeItem({
  opt,
  active,
  onSelect,
}: {
  opt: ThemeOption;
  active: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <Command.Item value={`theme ${opt.name} ${opt.collection}`} onSelect={onSelect} className={ITEM_CLASS}>
      <Palette size={14} strokeWidth={1.5} aria-hidden />
      <span className="truncate">{opt.name}</span>
      <span className="ml-auto flex items-center gap-1.5">
        {opt.colorblindSafe && (
          <span className="rounded border border-chrome-border-strong px-1 py-px text-[9px] uppercase tracking-wide text-chrome-fg-subtle">
            CB
          </span>
        )}
        {active && <Check size={13} strokeWidth={2} aria-hidden />}
      </span>
    </Command.Item>
  );
}
