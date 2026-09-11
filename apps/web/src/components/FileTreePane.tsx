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
import { useEffect, useMemo, useState } from 'react';
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
  const { fileList, isViewed, selectedPath, setSelectedPath, expandFileForNavigation } = useReview();
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

  const { model } = useFileTree({
    preparedInput,
    gitStatus,
    icons: 'standard',
    renderRowDecoration: ({ item }): FileTreeRowDecoration | null => {
      const entry = byPath.get(item.path);
      if (entry === undefined) return null;
      if (entry.generated) return { text: 'gen', title: 'Generated / vendored file' };
      if (isViewed(entry)) return { text: '✓', title: 'Viewed' };
      return null;
    },
    onSelectionChange: (selected) => {
      const first = selected[0];
      if (first !== undefined) {
        setSelectedPath(first);
        // Navigating to a file should never land on a collapsed diff.
        expandFileForNavigation(first);
      }
    },
  });

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
