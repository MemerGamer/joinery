/**
 * Left pane: the changed-files tree (SPEC §6). Static — never reordered by
 * the reading order — with git-status decorations and per-file "viewed"
 * checks in the row.
 */
import { FileTree, useFileTree } from '@pierre/trees/react';
import { preparePresortedFileTreeInput } from '@pierre/trees';
import type { GitStatusEntry, FileTreeRowDecoration } from '@pierre/trees';
import { useEffect, useMemo } from 'react';
import type { FileStatus } from '@review/core';
import { compareFileEntries } from '@review/core';
import { useReview } from '../state/ReviewContext.tsx';

const STATUS_MAP: Record<FileStatus, GitStatusEntry['status']> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'added',
};

export function FileTreePane(): React.JSX.Element {
  const { fileList, isViewed, selectedPath, setSelectedPath } = useReview();
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
      if (first !== undefined) setSelectedPath(first);
    },
  });

  useEffect(() => {
    if (selectedPath !== null) model.scrollToPath(selectedPath, { offset: 'nearest' });
  }, [selectedPath, model]);

  return (
    // `--trees-density-override` widens the library's own row height/padding
    // (see @pierre/trees' style.js: row height and radius both scale off
    // this variable) so rows are comfortably clickable instead of tightly
    // stacked, without reimplementing the tree's internal row rendering.
    <nav
      aria-label="Changed files"
      className="flex h-full w-full flex-col overflow-hidden [--trees-density-override:1.15]"
    >
      <FileTree model={model} />
    </nav>
  );
}
