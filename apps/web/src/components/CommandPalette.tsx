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
 * A fourth mode, `file`, has no trigger character of its own — it's a
 * dedicated, single-purpose view over the same file list root shows, reached
 * only via `initialMode="file"` (bound to `Cmd+P`; `Cmd+Shift+P` opens
 * `initialMode="command"`, landing straight in `>`). Since it can't be
 * spelled in the search string, it's tracked in a small `forcedMode` piece
 * of state instead, one that a real mode-prefix character always overrides
 * (typing `#`/`>`/`@` while forced into `file` mode switches away from it
 * immediately) and that's cleared whenever the palette closes.
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
  Sun,
  Moon,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import { listThemeOptions, type ThemeOption } from '../lib/themes.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';

type Mode = 'root' | 'command' | 'theme' | 'review' | 'file';

/** The two modes reachable directly (without typing a prefix) via `initialMode`. */
type ForcedMode = 'command' | 'file';

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
  file: 'Jump to a file…',
};

const MODE_LABEL: Record<Mode, string> = {
  root: 'Jump to',
  command: 'Commands',
  theme: 'Themes',
  review: 'Reviews',
  file: 'Files',
};

/** Root-mode groups show at most this many rows until the user actually types a query. */
const ROOT_CAP = 6;

// Deliberately no `transition-colors` (or any other transition/animation) on
// this class: the palette is a keyboard-driven launcher, and hover/arrow-key
// highlight has to land on the row the instant it's selected. An animated
// background lags visibly behind a held-down arrow key and reads as broken.
// Do not re-add a transition here for selected/hover state.
const ITEM_CLASS =
  'flex items-center gap-2 rounded-md px-2 py-1 text-body text-chrome-fg outline-hidden data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg [&_svg]:shrink-0 [&_svg]:text-chrome-fg-subtle data-[selected=true]:[&_svg]:text-chrome-accent-fg';

/** Builds the same `Command.Item` `value` string used for a theme option, both to render it and to look it up again from `Command`'s `onValueChange` (see the live-preview effect below). */
function themeItemValue(opt: ThemeOption): string {
  return `theme ${opt.name} ${opt.collection}`;
}

export function CommandPalette({
  open,
  onOpenChange,
  initialMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the palette directly in a sub-mode, bypassing root. See the file-top doc comment. */
  // Explicitly `| undefined` because the project runs with
  // `exactOptionalPropertyTypes`: callers pass a state variable that is
  // `undefined` for the root view, which an ordinary `?:` would reject.
  initialMode?: ForcedMode | undefined;
}): React.JSX.Element {
  const review = useReview();
  const { chromeMode, setChromeMode, diffTheme, setDiffTheme } = useTheme();
  const [search, setSearch] = useState('');
  const [forcedMode, setForcedMode] = useState<ForcedMode | null>(null);
  const [reviewList, setReviewList] = useState<{ id: string; branch: string | null }[]>([]);
  // The currently-highlighted item's cmdk `value`, kept controlled so theme
  // mode can observe it (see the live-preview effect below) — cmdk only
  // calls `onValueChange` for an *externally controlled* `value`.
  const [highlightedValue, setHighlightedValue] = useState('');

  const parsed = parseSearch(search);
  // A real mode-prefix character in the search string always wins over a
  // forced mode: typing `#`/`>`/`@` while the palette opened straight into
  // `file` (or `command`) mode should switch away from it immediately.
  const mode: Mode = parsed.mode !== 'root' ? parsed.mode : (forcedMode ?? 'root');
  const { query } = parsed;

  useEffect(() => {
    if (!open) return;
    callApi('listReviews')
      .then((res) => setReviewList(res.reviews.map((r) => ({ id: r.id, branch: r.branch }))))
      .catch(() => undefined);
  }, [open]);

  // Defect: search query was never reset on close, so reopening showed
  // stale filtering. Reset back to root with an empty query every time —
  // and adopt `initialMode` (if any) fresh on every open, so a caller that
  // wants the file-jump view doesn't have to fight state left over from the
  // previous time the palette was open.
  useEffect(() => {
    if (open) {
      setForcedMode(initialMode ?? null);
    } else {
      setSearch('');
      setForcedMode(null);
    }
  }, [open, initialMode]);

  // listThemeOptions() was being called on every render — memoize it, and
  // never slice it: all 75 themes stay reachable (SPEC §6).
  const themeOptions = useMemo(() => listThemeOptions(), []);
  const colorblindThemes = useMemo(() => themeOptions.filter((o) => o.colorblindSafe), [themeOptions]);
  const otherThemes = useMemo(() => themeOptions.filter((o) => !o.colorblindSafe), [themeOptions]);
  const activeThemeName = chromeMode === 'dark' ? diffTheme.dark : diffTheme.light;
  const themeValueMap = useMemo(() => new Map(themeOptions.map((o) => [themeItemValue(o), o])), [themeOptions]);

  const close = () => onOpenChange(false);

  // cmdk's own fuzzy filter (`defaultFilter`, from the `command-score`
  // library), but scored against the query with its mode prefix stripped —
  // so `#dra` filters the theme list by `dra`, not by the literal `#dra`.
  const filter = useCallback((value: string, rawSearch: string): number => {
    const { query: q } = parseSearch(rawSearch);
    if (q === '') return 1;
    return defaultFilter(value, q);
  }, []);

  // Live theme preview (SPEC-adjacent polish): moving the highlighted row in
  // theme mode applies that theme immediately, so scrolling through with the
  // arrow keys previews each one as you go. `previewRef` remembers the theme
  // that was active *before* the user entered theme mode, and whether they
  // actually committed one (Enter/click) — if they back out (Escape,
  // switching to another mode, or closing the palette) without committing,
  // it's restored.
  const previewRef = useRef<{ entryName: string; committed: boolean } | null>(null);

  // Tracks entering/leaving theme mode. Deliberately keyed on `mode` alone —
  // not on `diffTheme`/`chromeMode`/`activeThemeName`, which this effect also
  // reads: those change continuously as the preview below fires, and this
  // effect must run only on the theme-mode transition itself, not on every
  // preview tick (that would immediately "restore" the very preview it just
  // applied).
  useEffect(() => {
    if (mode === 'theme') {
      if (previewRef.current === null) {
        previewRef.current = { entryName: activeThemeName, committed: false };
      }
    } else if (previewRef.current !== null) {
      if (!previewRef.current.committed) {
        setDiffTheme({ ...diffTheme, [chromeMode]: previewRef.current.entryName });
      }
      previewRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Applies the preview itself. Also deliberately not keyed on
  // `diffTheme`/`chromeMode` for the same reason as above — applying a
  // preview changes `diffTheme`, which must not re-trigger this effect
  // against the same `highlightedValue`.
  useEffect(() => {
    if (mode !== 'theme') return;
    const opt = themeValueMap.get(highlightedValue);
    if (opt === undefined) return;
    setDiffTheme({ ...diffTheme, [chromeMode]: opt.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedValue, mode, themeValueMap]);

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

  const fileItems = files.map((f) => (
    <Command.Item key={f.path} value={`file ${f.path}`} onSelect={() => goToFile(f.path)} className={ITEM_CLASS}>
      <FileText size={14} strokeWidth={1.5} aria-hidden />
      <span className="truncate">{f.path}</span>
    </Command.Item>
  ));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      // cmdk's `Command.Dialog` renders this whole backdrop (Radix Dialog's
      // `Content`, not its `Overlay`) as one full-viewport element, with our
      // actual dialog frame as its one child — so a click that lands on the
      // backdrop itself (not bubbled up from the frame) is, structurally,
      // still "inside" Radix's Content, and Radix's own outside-click
      // dismissal never sees it. Closing on it is on us instead: only fire
      // when the click target *is* this backdrop element, not a descendant.
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      shouldFilter
      filter={filter}
      value={highlightedValue}
      onValueChange={setHighlightedValue}
      loop
    >
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg-raised shadow-[var(--chrome-shadow)] focus-within:border-chrome-accent">
        <div className="flex items-center gap-2 border-b border-chrome-border px-3 py-2">
          {mode !== 'root' && (
            <span className="shrink-0 rounded-md border border-chrome-border-strong bg-chrome-bg-sunken px-1.5 py-0.5 text-micro font-medium uppercase tracking-wide text-chrome-fg-subtle">
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
            // The input is always focused while the palette is open (see
            // `autoFocus` above), so the app-wide `:focus-visible` ring
            // (index.css) would just sit there permanently, loud and
            // pointless. It's suppressed here with `!` (important) because
            // that global rule is unlayered CSS and normally beats any
            // Tailwind utility regardless of specificity or source order;
            // the frame's own `focus-within:border-chrome-accent` above is
            // the palette's real "focused" treatment instead.
            className="w-full bg-transparent text-body text-chrome-fg outline-hidden! placeholder:text-chrome-fg-subtle"
          />
        </div>
        <Command.List className="max-h-96 overflow-y-auto p-1.5">
          <Command.Empty className="p-6 text-center text-xs text-chrome-fg-muted">No results.</Command.Empty>

          {mode === 'root' && (
            <>
              {files.length > 0 && <Group heading="Files">{fileItems}</Group>}

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

          {mode === 'file' && files.length > 0 && <Group heading="Files">{fileItems}</Group>}

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
              {/*
                * Light/dark *chrome* mode, distinct from the `#` theme mode
                * below (which picks the syntax theme used for whichever
                * chrome mode is active). This used to live in a header
                * ThemePicker; with that removed, the palette is the only
                * place it is reachable from, so it belongs in the command
                * list rather than only in the theme sub-mode.
                */}
              <Command.Item
                value="toggle light dark chrome mode appearance"
                onSelect={() => {
                  setChromeMode(chromeMode === 'dark' ? 'light' : 'dark');
                  close();
                }}
                className={ITEM_CLASS}
              >
                {chromeMode === 'dark' ? (
                  <Sun size={14} strokeWidth={1.5} aria-hidden />
                ) : (
                  <Moon size={14} strokeWidth={1.5} aria-hidden />
                )}
                Switch to {chromeMode === 'dark' ? 'light' : 'dark'} mode
              </Command.Item>
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
                        if (previewRef.current !== null) previewRef.current.committed = true;
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
                        if (previewRef.current !== null) previewRef.current.committed = true;
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
        <span className="block px-2 pt-2 pb-1 text-micro font-medium uppercase tracking-wide text-chrome-fg-subtle">
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
    <kbd className="ml-auto rounded border border-chrome-border-strong px-1.5 py-0.5 text-micro text-chrome-fg-subtle">
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
    <Command.Item value={themeItemValue(opt)} onSelect={onSelect} className={ITEM_CLASS}>
      <Palette size={14} strokeWidth={1.5} aria-hidden />
      <span className="truncate">{opt.name}</span>
      <span className="ml-auto flex items-center gap-1.5">
        {opt.colorblindSafe && (
          <span className="rounded border border-chrome-border-strong px-1 py-px text-micro uppercase tracking-wide text-chrome-fg-subtle">
            CB
          </span>
        )}
        {active && <Check size={13} strokeWidth={2} aria-hidden />}
      </span>
    </Command.Item>
  );
}
