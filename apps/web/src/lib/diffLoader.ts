/**
 * Fetches and parses per-file patches on demand, and hydrates full file
 * contents for `loadDiffFiles`.
 *
 * Patches are cached client-side by `(oldBlob, newBlob)`, which is immutable,
 * so the cache never expires — matching the same cache-by-blob-SHA rule as
 * the worker pool's own highlight cache.
 */
import { parsePatchFiles, trimPatchContext, type FileDiffLoadedFiles, type FileDiffMetadata } from '@pierre/diffs';
import { NULL_BLOB, type FileEntry, type Revision } from '@joinery/core';
import { callApi } from './apiClient.ts';

const patchCache = new Map<string, Promise<FileDiffMetadata>>();

/**
 * The identity of a file's *content*, not its path. A loaded `FileDiffMetadata`
 * carries this as its `cacheKey`, so comparing it against the blob pair of the
 * current `FileEntry` is how callers tell "this item's diff is up to date" from
 * "this item is showing a patch from before the last live update".
 */
export function blobPairKey(entry: Pick<FileEntry, 'oldBlob' | 'newBlob'>): string {
  return `${entry.oldBlob}:${entry.newBlob}`;
}

/** Builds the placeholder shown before a file's real patch has loaded. */
export function placeholderFileDiff(entry: FileEntry): FileDiffMetadata {
  return {
    name: entry.path,
    ...(entry.oldPath !== null ? { prevName: entry.oldPath } : {}),
    type:
      entry.status === 'added'
        ? 'new'
        : entry.status === 'deleted'
          ? 'deleted'
          : entry.status === 'renamed'
            ? 'rename-changed'
            : 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    deletionCharacterCount: 0,
    additionCharacterCount: 0,
    cacheKey: `${blobPairKey(entry)}:loading`,
  };
}

/**
 * Fetches one file's patch and parses it into `FileDiffMetadata`. Never call
 * during render — this is for effects/event handlers, which is also why
 * `parsePatchFiles` shows up here and nowhere in the component tree.
 */
export async function loadFileDiff(
  reviewId: string,
  entry: FileEntry,
  revision: Revision | undefined,
  signal?: AbortSignal,
): Promise<FileDiffMetadata> {
  const cacheKey = blobPairKey(entry);
  const cached = patchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const promise = (async () => {
    if (entry.binary) {
      return {
        name: entry.path,
        ...(entry.oldPath !== null ? { prevName: entry.oldPath } : {}),
        type: entry.status === 'added' ? 'new' : entry.status === 'deleted' ? 'deleted' : 'change',
        hunks: [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        isPartial: false,
        deletionLines: [],
        additionLines: [],
        deletionCharacterCount: 0,
        additionCharacterCount: 0,
        cacheKey,
      } satisfies FileDiffMetadata;
    }

    const { patch } = await callApi('getDiff', {
      params: [reviewId],
      query: { path: entry.path, ...(revision !== undefined ? { rev: revision } : {}) },
      ...(signal !== undefined ? { signal } : {}),
    });

    const trimmed = trimPatchContext(patch.patch);
    const parsed = parsePatchFiles(trimmed, cacheKey)[0]?.files[0];
    const fileDiff: FileDiffMetadata = parsed ?? {
      name: entry.path,
      type: 'change',
      hunks: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      isPartial: false,
      deletionLines: [],
      additionLines: [],
      deletionCharacterCount: 0,
      additionCharacterCount: 0,
      cacheKey,
    };
    fileDiff.cacheKey = cacheKey;
    return fileDiff;
  })();

  patchCache.set(cacheKey, promise);
  promise.catch(() => patchCache.delete(cacheKey));
  return promise;
}

const contentsCache = new Map<string, Promise<FileDiffLoadedFiles>>();

/**
 * `loadDiffFiles` for `CodeView`/`FileDiff`: hydrates a partial diff with
 * full file contents when the user expands unchanged context. Each side's `cacheKey` is its own blob SHA so an
 * expanded region reuses the highlight cache instead of re-tokenizing.
 */
export function makeLoadDiffFiles(
  reviewId: string,
  revision: Revision | undefined,
): (fileDiff: FileDiffMetadata) => Promise<FileDiffLoadedFiles> {
  return async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    // Keyed by the diff's own `cacheKey` (the blob pair, set by `loadFileDiff`)
    // and not just the path: when a live update changes a file, the new patch
    // has a new blob pair, and a path-only key would serve the contents from
    // before the update when the user expands unchanged context.
    const key = `${reviewId}:${fileDiff.name}:${revision ?? ''}:${fileDiff.cacheKey}`;
    const cached = contentsCache.get(key);
    if (cached !== undefined) return cached;

    const promise = (async (): Promise<FileDiffLoadedFiles> => {
      const { contents } = await callApi('getContents', {
        params: [reviewId],
        query: { path: fileDiff.name, ...(revision !== undefined ? { rev: revision } : {}) },
      });
      const newFile = {
        name: fileDiff.name,
        contents: contents.newContents ?? '',
        cacheKey: contents.newBlob,
      };
      if (contents.oldBlob === NULL_BLOB || contents.oldContents === null) {
        return { oldFile: null, newFile };
      }
      return {
        oldFile: {
          name: fileDiff.prevName ?? fileDiff.name,
          contents: contents.oldContents,
          cacheKey: contents.oldBlob,
        },
        newFile,
      };
    })();

    contentsCache.set(key, promise);
    promise.catch(() => contentsCache.delete(key));
    return promise;
  };
}

export function clearDiffCaches(): void {
  patchCache.clear();
  contentsCache.clear();
}
