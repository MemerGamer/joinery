/**
 * Left pane: the changed-files tree (SPEC §6). Static — never reordered by
 * the reading order — with git-status decorations and per-file "viewed"
 * checks in the row.
 *
 * `@pierre/trees` renders `<FileTree>` into a shadow root, so it never
 * inherits the app's `data-theme` attribute or `--chrome-*` custom
 * properties — its own stylesheet only understands its `--trees-theme-*`
 * variables (with a `--trees-*-override → --trees-theme-* → default`
 * fallback chain; see the `--trees-density-override` comment below for the
 * same mechanism used for density). `themeToTreeStyles` maps a resolved
 * Shiki/VS Code-shaped theme onto that variable set, so the tree is told
 * the active theme explicitly, in step with the diff theme shown in
 * `CodeView`, rather than trying (and failing) to inherit chrome mode.
 */
import { FileTree, useFileTree } from '@pierre/trees/react';
import { preparePresortedFileTreeInput, themeToTreeStyles } from '@pierre/trees';
import type { GitStatusEntry, FileTreeRowDecoration, TreeThemeStyles } from '@pierre/trees';
import { resolveTheme } from '@pierre/diffs';
import { useEffect, useMemo, useRef, useState } from 'react';
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

export function FileTreePane(): React.JSX.Element {
  const { fileList, viewed, isViewed, selectedPath, setSelectedPath, expandFileForNavigation } =
    useReview();
  const { chromeMode, diffTheme } = useTheme();
  const activeThemeName = chromeMode === 'dark' ? diffTheme.dark : diffTheme.light;
  const [treeStyles, setTreeStyles] = useState<TreeThemeStyles | undefined>(undefined);
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
  const liveRef = useRef({ byPath, isViewed, setSelectedPath, expandFileForNavigation });
  liveRef.current = { byPath, isViewed, setSelectedPath, expandFileForNavigation };

  const { model } = useFileTree({
    preparedInput,
    gitStatus,
    icons: 'standard',
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
    // Only *visible* rows can be enumerated, so an expanded directory nested
    // inside a collapsed one isn't captured and reverts to its default state.
    // Acceptable: the tree is changed-files-only and shallow in practice.
    const rows = model.getVisibleRows(0, model.getVisibleCount());
    const initialExpandedPaths = rows
      .filter((r) => r.kind === 'directory' && r.isExpanded)
      .map((r) => r.path);
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

  // Resolve the active theme's colours and hand them to the tree's shadow
  // root explicitly (see the file-top comment). Guarded against out-of-order
  // resolution when `activeThemeName` changes again before this resolves.
  useEffect(() => {
    let cancelled = false;
    resolveTheme(activeThemeName)
      .then((resolved) => {
        if (!cancelled) setTreeStyles(themeToTreeStyles(resolved));
      })
      .catch(() => {
        // Best-effort: the tree just keeps its previous/default styles.
      });
    return () => {
      cancelled = true;
    };
  }, [activeThemeName]);

  return (
    // `--trees-density-override` widens the library's own row height/padding
    // (see @pierre/trees' style.js: row height and radius both scale off
    // this variable) so rows are comfortably clickable instead of tightly
    // stacked, without reimplementing the tree's internal row rendering.
    <nav
      aria-label="Changed files"
      className="flex h-full w-full flex-col overflow-hidden [--trees-density-override:1.15]"
    >
      <FileTree model={model} style={treeStyles} />
    </nav>
  );
}
