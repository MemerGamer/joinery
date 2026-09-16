/**
 * Left pane: the changed-files tree (SPEC §6). Static — never reordered by
 * the reading order — with git-status decorations and per-file "viewed"
 * checks in the row.
 *
 * `@pierre/trees` renders `<FileTree>` into a shadow root, so it never
 * inherits the app's `data-theme` attribute or `--chrome-*` custom
 * properties — its own stylesheet only understands its `--trees-theme-*`
 * variables (with a `--trees-*-override → --trees-theme-* → default`
 * fallback chain). `chromeToTreeStyles` below reads the app's own
 * `--chrome-*` custom properties off `documentElement` and maps them onto
 * that variable set explicitly, so the tree matches the surrounding chrome
 * (not the selected diff/syntax theme — the tree is not a piece of code,
 * it's UI, so it should track light/dark chrome mode only). Row density is a
 * separate mechanism from this override chain — see the `density` option
 * passed to `useFileTree` below.
 */
import { FileTree, useFileTree } from '@pierre/trees/react';
import { preparePresortedFileTreeInput } from '@pierre/trees';
import type { GitStatusEntry, FileTreeRowDecoration, TreeThemeStyles } from '@pierre/trees';
import { useEffect, useMemo, useRef } from 'react';
import type { FileStatus } from '@review/core';
import { compareFileEntries } from '@review/core';
import { useReview } from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';

const STATUS_MAP: Record<FileStatus, GitStatusEntry['status']> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'added',
};

/**
 * Maps the app's `--chrome-*` custom properties (styles/index.css) onto
 * `@pierre/trees`' `--trees-theme-*` variable set. Read via `getComputedStyle`
 * rather than hardcoded, so this stays correct if the chrome palette's actual
 * colour values ever change — only the *mapping* between the two variable
 * sets lives here. `--chrome-*` has no dedicated "modified"/"renamed"/
 * "untracked"/"ignored" slots (those are git-status concepts the chrome
 * palette doesn't need elsewhere), so those four borrow the closest chrome
 * semantic colour: modified→accent, renamed→warning, untracked→success (new,
 * like added), ignored→fg-subtle (de-emphasized, like a muted/disabled row).
 */
function chromeToTreeStyles(): TreeThemeStyles {
  const style = getComputedStyle(document.documentElement);
  const chrome = (name: string): string => style.getPropertyValue(name).trim();
  return {
    '--trees-theme-sidebar-bg': chrome('--chrome-bg'),
    '--trees-theme-sidebar-fg': chrome('--chrome-fg'),
    '--trees-theme-sidebar-header-fg': chrome('--chrome-fg-muted'),
    '--trees-theme-sidebar-border': chrome('--chrome-border'),
    '--trees-theme-list-hover-bg': chrome('--chrome-bg-hover'),
    // Tint rather than a solid accent block — see `chrome-row-selected` in
    // styles/index.css; the tree can't use that utility (shadow root) so the
    // same treatment is spelled out here.
    '--trees-theme-list-active-selection-bg': chrome('--chrome-accent-soft'),
    '--trees-theme-list-active-selection-fg': chrome('--chrome-fg'),
    '--trees-theme-input-bg': chrome('--chrome-bg'),
    '--trees-theme-input-fg': chrome('--chrome-fg'),
    // No outline on the focused/selected row: the tint alone marks it,
    // matching the reading-order rows.
    '--trees-theme-focus-ring': 'transparent',
    '--trees-theme-scrollbar-thumb': chrome('--chrome-border-strong'),
    '--trees-theme-git-added-fg': chrome('--chrome-success'),
    '--trees-theme-git-modified-fg': chrome('--chrome-accent'),
    '--trees-theme-git-deleted-fg': chrome('--chrome-danger'),
    '--trees-theme-git-renamed-fg': chrome('--chrome-warning'),
    '--trees-theme-git-untracked-fg': chrome('--chrome-success'),
    '--trees-theme-git-ignored-fg': chrome('--chrome-fg-subtle'),
  };
}

/**
 * Every ancestor directory path (no trailing slash — `getItem`/
 * `initialExpandedPaths` both accept the bare form) implied by a flat list of
 * file paths, e.g. `"a/b/c.ts"` implies `"a"` and `"a/b"`. Used to derive the
 * full expand-everything set directly from the file list, rather than from
 * `getVisibleRows`, which only sees rows the virtualizer currently renders —
 * a directory nested inside a collapsed one never shows up there at all.
 */
function collectDirectoryPaths(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      dirs.add(segments.slice(0, i).join('/'));
    }
  }
  return [...dirs];
}

export function FileTreePane(): React.JSX.Element {
  const { fileList, viewed, isViewed, selectedPath, setSelectedPath, expandFileForNavigation, codeViewRef } =
    useReview();
  const { chromeMode, chromeVersion } = useTheme();
  const byPath = useMemo(() => new Map(fileList.map((f) => [f.path, f])), [fileList]);

  const sorted = useMemo(() => [...fileList].sort(compareFileEntries), [fileList]);
  const paths = useMemo(() => sorted.map((f) => f.path), [sorted]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => sorted.map((f) => ({ path: f.path, status: STATUS_MAP[f.status] })),
    [sorted],
  );
  const preparedInput = useMemo(() => preparePresortedFileTreeInput(paths), [paths]);

  // `useFileTree` is `useState(() => new FileTree(options))` — the initializer
  // runs once and every later `options` object is discarded, and `FileTree`
  // keeps `renderRowDecoration`/`onSelectionChange` in private fields with no
  // setter. So both callbacks below must be treated as captured-at-mount
  // forever: they read live data through this ref instead of closing over it,
  // or the tree renders whatever the first render happened to see (which is
  // why the "viewed" check never appeared).
  const liveRef = useRef({ byPath, isViewed, setSelectedPath, expandFileForNavigation, codeViewRef });
  liveRef.current = { byPath, isViewed, setSelectedPath, expandFileForNavigation, codeViewRef };

  const { model } = useFileTree({
    preparedInput,
    gitStatus,
    icons: 'standard',
    // `density`/`itemHeight` are only read once, at construction (`useFileTree`
    // is a bare `useState` initializer — see the capture-at-mount comment on
    // `liveRef` below), and the model writes its *resolved* row height and
    // density factor onto the host element's own inline style the first time
    // it mounts (`#applyDensityHostStyle` in `@pierre/trees`' `render/FileTree.js`).
    // That inline value on the host always wins over a `--trees-density-override`
    // set from an ancestor (an element's own specified value beats an inherited
    // one), which is why the old `[--trees-density-override:1.15]` className
    // below had silently stopped doing anything — the host was pinning itself
    // to the untouched default (factor 1, 30px rows) regardless.
    // `@pierre/trees` only ships three density presets (see
    // `FILE_TREE_DENSITY_PRESETS` in its `model/density.js`): `'default'`
    // (30px rows, factor 1 — the original, too-airy setting) and `'compact'`
    // (24px rows, factor 0.8 — the later overcorrection the user asked to back
    // off from). Neither preset lands where the user wants, and there's no
    // `'cozy'`/`'comfortable'` preset in between, so this passes `density` as
    // the raw *number* 0.9 (the resolver accepts a numeric factor directly)
    // with an explicit `itemHeight: 27`. Both are exactly the midpoint between
    // `default` and `compact` (30→27 is the same 0.9 ratio as 1→0.9), so
    // padding/indent/gap/border-radius — which all scale off the factor, not
    // the row height — stay proportional to the row height instead of the
    // mismatched combination you'd get from mixing a preset's factor with a
    // separately-chosen row height. 27px reads as a clear step up from
    // `compact`'s 24px without going back to `default`'s noticeably looser 30px.
    density: 0.9,
    itemHeight: 27,
    // Every directory open on first render (task: "fully expanded by
    // default"). `initialExpansion` is only read at construction time — the
    // resync effect below has no equivalent option, so it has to fall back
    // to an explicit `initialExpandedPaths` set instead.
    initialExpansion: 'open',
    renderRowDecoration: ({ item }): FileTreeRowDecoration | null => {
      const entry = liveRef.current.byPath.get(item.path);
      if (entry === undefined) return null;
      if (entry.generated) return { text: 'gen', title: 'Generated / vendored file' };
      if (liveRef.current.isViewed(entry)) return { text: '✓', title: 'Viewed' };
      return null;
    },
    onSelectionChange: (selected) => {
      const first = selected[0];
      if (first !== undefined) {
        liveRef.current.setSelectedPath(first);
        // Navigating to a file should never land on a collapsed diff.
        liveRef.current.expandFileForNavigation(first);
        // Selection only fires from clicks/keys inside the tree (nothing
        // pushes `selectedPath` back into the model), so scrolling here
        // can't loop with the reading-order pane's own jump.
        liveRef.current.codeViewRef.current?.scrollTo({ type: 'item', id: first, align: 'start' });
      }
    },
  });

  // A ref alone only makes the callbacks *correct when they run*; nothing in
  // the tree re-runs them on its own. `resetPaths` is the supported way to
  // push a new path set, and it re-renders, which also refreshes decorations.
  // Keyed on the viewed set too, so ticking a file off updates its row.
  const viewedKey = useMemo(
    () => fileList.map((f) => (viewed.get(f.path) === f.newBlob ? '1' : '0')).join(''),
    [fileList, viewed],
  );
  // The constructor already consumed the first render's input; re-running the
  // sync for it would reset the tree for nothing.
  const syncedOnce = useRef(false);
  useEffect(() => {
    if (!syncedOnce.current) {
      syncedOnce.current = true;
      return;
    }
    // `resetPaths` has no "expand everything" option of its own (unlike the
    // constructor's `initialExpansion` above) — it only takes an explicit
    // `initialExpandedPaths` list. Derive that list from every directory
    // implied by the new path set (not from `getVisibleRows`, which misses
    // directories nested inside a currently-collapsed one, since those rows
    // are never rendered at all) and default it to *expanded*, so a
    // directory that didn't exist before this sync opens by default too.
    // A directory the model already knows about keeps whatever the user last
    // left it as via `getItem(...).isExpanded()` — a manual collapse should
    // survive an unrelated resync (e.g. one triggered only by `viewedKey`),
    // it just doesn't get to fight the "expanded by default" rule for a
    // brand-new directory.
    const initialExpandedPaths = collectDirectoryPaths(paths).filter((dirPath) => {
      const item = model.getItem(dirPath);
      // `isDirectory()` returns a plain boolean (not a type predicate), so it
      // doesn't narrow `FileTreeItemHandle`; check for the directory-only
      // `isExpanded` method itself instead.
      return item === null || ('isExpanded' in item && item.isExpanded());
    });
    model.resetPaths({ preparedInput, initialExpandedPaths });
    model.setGitStatus(gitStatus);
    if (selectedPath !== null) model.scrollToPath(selectedPath, { offset: 'nearest' });
    // `selectedPath` is read for scroll restoration but must not drive this
    // effect — selection has its own effect below, and resetting the tree on
    // every selection change would be gratuitous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, preparedInput, gitStatus, viewedKey]);

  useEffect(() => {
    if (selectedPath !== null) model.scrollToPath(selectedPath, { offset: 'nearest' });
  }, [selectedPath, model]);

  // Read the app's own chrome colours and hand them to the tree's shadow
  // root explicitly (see the file-top comment). Unlike the old diff-theme
  // mapping, this is a synchronous CSS read, not an async theme resolution —
  // and it's keyed on `chromeMode` only, not on the selected diff theme, so
  // picking a different diff/syntax theme never touches the tree's colours.
  // `chromeMode`'s setter writes `documentElement`'s `data-theme` attribute
  // synchronously before the state update that re-renders this component, so
  // by the time this runs, `getComputedStyle` already sees the new value.
  // `chromeVersion` bumps after `lib/deriveChrome.ts` rewrites the palette
  // from the active diff theme, which is the other time these change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const treeStyles = useMemo(() => chromeToTreeStyles(), [chromeMode, chromeVersion]);

  return (
    // `pt-4 pb-2`, not padding inside the tree itself: `@pierre/trees` renders
    // its own scroll container (`[data-file-tree-virtualized-scroll]`) inside
    // the shadow root and virtualizes rows against that element's own
    // scrollTop/clientHeight — the library exposes `--trees-padding-inline`
    // for *horizontal* inset (applied to that same scroll container, and
    // already active by default, which is why the sides already had some
    // room), but nothing equivalent for top/bottom. Padding the scroll
    // container directly (even via that inline var, if it had a block
    // counterpart) risks the same clipping/offset problems the task warns
    // about, since row offsets are computed relative to that box. Padding
    // this outer `<nav>` instead only shrinks the box `<FileTree>` is asked
    // to fill (it sizes itself to `height: 100%` of its parent — see the
    // `:host([data-file-tree-virtualized="true"])` rule in the library's
    // stylesheet) — the tree's own internal scroll math never sees it, so
    // scrolling/virtualization behave exactly as before, just inside a
    // slightly smaller, better-inset box.
    <nav aria-label="Changed files" className="flex h-full w-full flex-col overflow-hidden pb-2">
      <div className="flex h-10 shrink-0 items-center gap-2 px-4">
        <h2 className="text-body font-medium text-chrome-fg">Files</h2>
        <span className="text-micro tabular-nums text-chrome-fg-subtle">{fileList.length}</span>
      </div>
      <FileTree model={model} style={treeStyles} />
    </nav>
  );
}
