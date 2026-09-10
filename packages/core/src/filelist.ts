/**
 * The set-diff (§5, *The delta*).
 *
 * The list *is* the state: to detect change you compare the new list against
 * the old one, and the set difference is the delta. There is no digest, no
 * snapshot hash, and no cache invalidation — `cacheKey` is the blob SHA, so new
 * content has a new key by construction.
 *
 * Shared by the server (deciding whether to push) and the client (applying).
 */
import type { FileEntry } from './domain/files.ts';

export type FileListDelta = {
  added: FileEntry[];
  removed: FileEntry[];
  /** `mutate the item's fileDiff in place and bump item.version` on the client. */
  changed: { before: FileEntry; after: FileEntry }[];
  /** Rename entries, so `thread.path` and `file_viewed.path` are rewritten (§6). */
  renamed: { from: string; to: string }[];
};

export const emptyDelta = (): FileListDelta => ({
  added: [],
  removed: [],
  changed: [],
  renamed: [],
});

export const isEmptyDelta = (d: FileListDelta): boolean =>
  d.added.length === 0 &&
  d.removed.length === 0 &&
  d.changed.length === 0 &&
  d.renamed.length === 0;

const sameEntry = (a: FileEntry, b: FileEntry): boolean =>
  a.oldBlob === b.oldBlob &&
  a.newBlob === b.newBlob &&
  a.status === b.status &&
  a.oldPath === b.oldPath &&
  a.binary === b.binary &&
  a.generated === b.generated &&
  a.additions === b.additions &&
  a.deletions === b.deletions;

export function diffFileLists(before: readonly FileEntry[], after: readonly FileEntry[]): FileListDelta {
  const delta = emptyDelta();
  const beforeByPath = new Map(before.map((f) => [f.path, f]));
  const afterByPath = new Map(after.map((f) => [f.path, f]));

  for (const next of after) {
    const prev = beforeByPath.get(next.path);
    if (prev === undefined) {
      delta.added.push(next);
      // A rename shows up as an add whose oldPath was present before, and the
      // matching remove is emitted by the loop below.
      if (next.oldPath !== null && beforeByPath.has(next.oldPath) && !afterByPath.has(next.oldPath)) {
        delta.renamed.push({ from: next.oldPath, to: next.path });
      }
    } else if (!sameEntry(prev, next)) {
      delta.changed.push({ before: prev, after: next });
    }
  }

  for (const prev of before) {
    if (!afterByPath.has(prev.path)) delta.removed.push(prev);
  }

  return delta;
}

/**
 * Apply a delta to a sorted list without re-sorting it: an added file is
 * spliced in at its sorted position so nothing else shifts (§5).
 */
export function applyDelta(current: readonly FileEntry[], delta: FileListDelta): FileEntry[] {
  const removed = new Set(delta.removed.map((f) => f.path));
  const changedByPath = new Map(delta.changed.map((c) => [c.after.path, c.after]));

  const next = current
    .filter((f) => !removed.has(f.path))
    .map((f) => changedByPath.get(f.path) ?? f);

  for (const entry of delta.added) {
    const at = next.findIndex((f) => compareFileEntries(f, entry) > 0);
    if (at === -1) next.push(entry);
    else next.splice(at, 0, entry);
  }

  return next;
}

/**
 * The canonical order, used both to sort a fresh list and to place an added
 * file into an existing one — they must agree or an insert lands in the wrong
 * spot. Generated files sort to the bottom, mirroring GitHub (§6).
 */
export function compareFileEntries(a: FileEntry, b: FileEntry): number {
  if (a.generated !== b.generated) return a.generated ? 1 : -1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function sortFileEntries(files: FileEntry[]): FileEntry[] {
  return files.sort(compareFileEntries);
}
